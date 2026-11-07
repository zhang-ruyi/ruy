---
layout: post
title: "C 的面向对象:Linux 驱动框架如何用结构体实现多态"
date: 2026-11-09
categories: [kernel-deep]
description: 用 struct + 函数指针 ops + container_of 复原 vtable、继承与组合,并深入 device/driver/bus、really_probe 与 devres 的生命周期管理
---
内核精读 · 驱动框架 · 源码基线 v7.4.0-rc1

C 没有 `class`,也没有 `virtual`,更没有析构函数。但 Linux 驱动框架里处处是面向对象:文件有统一的操作接口,设备能挂到总线上,驱动能热插拔,资源能在卸载时自动释放。它靠的不是语法糖,而是四个朴素的机制:**结构体嵌入、函数指针表、`container_of`、引用计数与资源链表**。本文把这些机制拆开,看看内核如何用最少的语言特性拼出多态、继承和 RAII。


## 一、C 的“对象”:结构体、函数指针与容器

面向对象常被简化为三件事:封装、多态、继承。C 的实现方式非常直接:

| OO 概念 | C 的对应物 | 内核例子 |
|---|---|---|
| 对象 / 成员变量 | `struct` | `struct file`、`struct device` |
| 虚函数表 / 接口 | 一组函数指针组成的 `struct xxx_operations` | `file_operations`、`bus_type` |
| 动态绑定 | 对象里存一个指向 ops 表的指针 | `file->f_op`、`inode->i_op` |
| 继承 / is-a | 把“基类”结构体作为第一个或普通成员嵌入 | `platform_device` 内嵌 `struct device` |
| 向上/向下转型 | `container_of` / 保存 `void *private_data` | `to_platform_device()` |
| 构造 / 析构 | `*_register` / `*_unregister`,devres | `device_register`、`devres_release_all` |

关键在于:**内核并不需要每个对象都带一张虚表**。ops 表通常是 `static const`,同类型对象共享同一张表;对象里只存一个指针。这和 C++ 编译器生成的 vptr 很接近,只是布局、命名和类型检查都由人负责。

## 二、ops 结构体:内核里的“接口”

VFS 是这套思想最集中的地方。`struct file`(`include/linux/fs.h:1257`)里有一个 `const struct file_operations *f_op`(`:1260`),它决定了这个打开的文件能做哪些操作。`file_operations` 定义在 `include/linux/fs.h:1922`,节选如下:

```c
struct file_operations {
        struct module *owner;
        fop_flags_t fop_flags;
        loff_t (*llseek) (struct file *, loff_t, int);
        ssize_t (*read) (struct file *, char __user *, size_t, loff_t *);
        ssize_t (*write) (struct file *, const char __user *, size_t, loff_t *);
        ssize_t (*read_iter) (struct kiocb *, struct iov_iter *);
        ssize_t (*write_iter) (struct kiocb *, struct iov_iter *);
        int (*iopoll) (struct kiocb *kiocb, struct io_comp_batch *, unsigned int);
        __poll_t (*poll) (struct file *, struct poll_table_struct *);
        long (*unlocked_ioctl) (struct file *, unsigned int, unsigned long);
        int (*mmap) (struct file *, struct vm_area_struct *);
        int (*open) (struct inode *, struct file *);
        int (*release) (struct inode *, struct file *);
        int (*fsync) (struct file *, loff_t, loff_t, int datasync);
        ssize_t (*splice_read) (struct file *, loff_t *, struct pipe_inode_info *, size_t, unsigned int);
        int (*uring_cmd) (struct io_uring_cmd *ioucmd, unsigned int issue_flags);
        ...
} __randomize_layout;
```

这不是“一个函数指针”,而是一整张**能力表**。某个文件系统只需要填自己关心的槽位,其余保持 `NULL`。调用方在调用前检查,例如 `new_sync_read`(`fs/read_write.c:483`)最终执行:

```c
ret = filp->f_op->read_iter(&kiocb, &iter);
```

VFS 完全不知道背后是 ext4、XFS、procfs 还是字符设备;它只知道“这个 `file` 的 `f_op` 里有 `read_iter`”。这就是多态。

同样的接口思想遍布内核:

| 结构体 | 定义位置 | 负责什么 |
|---|---|---|
| `file_operations` | `include/linux/fs.h:1922` | 打开文件后的读写、mmap、ioctl、poll |
| `inode_operations` | `include/linux/fs.h:2000` | 路径查找、创建、删除、权限、属性 |
| `address_space_operations` | `include/linux/fs.h:401` | 页缓存读写、回写、直接 IO、swap |
| `super_operations` | `include/linux/fs/super_types.h:83` | 文件系统挂载/卸载、inode 分配、统计 |

以 `address_space_operations`(`include/linux/fs.h:401`)为例,它把“页缓存如何与具体文件系统交互”抽象出来:

```c
struct address_space_operations {
        int (*read_folio)(struct file *, struct folio *);
        int (*writepages)(struct address_space *, struct writeback_control *);
        bool (*dirty_folio)(struct address_space *, struct folio *);
        void (*readahead)(struct readahead_control *);
        int (*write_begin)(const struct kiocb *, struct address_space *mapping,
                           loff_t pos, unsigned len, struct folio **foliop, void **fsdata);
        int (*write_end)(const struct kiocb *, struct address_space *mapping,
                         loff_t pos, unsigned len, unsigned copied,
                         struct folio *folio, void *fsdata);
        ssize_t (*direct_IO)(struct kiocb *, struct iov_iter *iter);
        ...
};
```

`address_space` 里保存 `const struct address_space_operations *a_ops`(`include/linux/fs.h:480`),`super_block` 里保存 `const struct super_operations *s_op`(`include/linux/fs/super_types.h:150`),`inode` 里保存 `i_op`(`include/linux/fs.h:773`)与 `i_fop`(`:849`)。每个“对象”都通过一个指针绑定到自己的“类方法表”。

这里还有一个容易被忽略的设计:**接口只规定“可以做什么”,不规定“必须怎么做”**。没有传统 `read` 的文件系统可以只实现 `read_iter`;不支持 `mmap` 的字符设备把槽位留空,VFS 会在调用点返回 `-EINVAL` 或改走通用路径。这种“可选方法”让同一个结构体能同时服务块设备、字符设备、procfs、socket 等差异极大的对象,而不需要为每种类型定义一套继承体系。接口因此是**能力集合**,而不是强制契约。

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/内核驱动框架/file-operations-dispatch.html' | relative_url }}" loading="lazy" title="file_operations 动态分派"></iframe>
  <figcaption>图 1:VFS 通过 file_operations 把通用调用分派到具体文件系统。</figcaption>
</figure>

这种设计的精妙之处在于:**接口是数据结构,不是语言关键字**。新增一种文件系统,不需要修改 VFS 的调用点,只需要提供一张新的 ops 表。开闭原则在 C 里靠“填表”实现。

## 三、container_of:把“基类指针”还原成“派生对象”

光有 ops 表还不够。总线上遍历的是 `struct device *`,而驱动真正想操作的往往是 `struct platform_device *` 或 `struct pci_dev *`。C 没有 `dynamic_cast`,靠的是 `container_of`。

定义在 `include/linux/container_of.h:19`:

```c
#define container_of(ptr, type, member) ({                              \
        static_assert(__same_type(*(ptr), typeof_member(type, member)) || \
                      __same_type(*(ptr), void),                        \
                      "pointer type mismatch in container_of()");       \
        (type *)((void *)(ptr) - offsetof(type, member)); })
```

它做的事只有一件:已知成员 `member` 在结构体 `type` 中的偏移,用成员地址减去偏移,就得到外层对象地址。`static_assert` 是后来加的类型保护,但本质上仍是**指针算术**,没有运行时类型信息。

这正是 C 版“继承”的基础。看 `struct platform_device`(`include/linux/platform_device.h:25`):

```c
struct platform_device {
        const char *name;
        int id;
        bool id_auto;
        struct device dev;      /* 内嵌的“基类” */
        u64 platform_dma_mask;
        ...
};

#define to_platform_device(x) container_of((x), struct platform_device, dev)
```

`platform_device` 内嵌了一个 `struct device dev`。总线、驱动核心、sysfs 都只认识 `struct device *`;平台驱动拿到这个指针后,用 `container_of` 还原出 `platform_device`,再访问 `resource`、`id` 等平台特有字段。`to_platform_driver`(`include/linux/platform_device.h:297`)同理,把 `struct device_driver *` 还原成 `struct platform_driver *`。

<div class="tree-map" role="img" aria-label="platform_device 的布局级包含关系">
  <div class="tree-map-head">
    <span class="tree-map-title">platform_device 的“继承”:布局级包含</span>
    <span class="tree-map-note">总线只持有 &amp;pdev-&gt;dev</span>
  </div>
  <ul>
    <li>
      <div class="tree-card tone-blue"><span class="tree-label">struct platform_device</span></div>
      <ul>
        <li><div class="tree-card tone-slate"><span class="tree-label">name / id / resource …</span></div></li>
        <li>
          <div class="tree-card tone-violet"><span class="tree-label">struct device dev</span><span class="tree-sub">内嵌的“基类”</span></div>
          <ul>
            <li><div class="tree-card tone-amber"><span class="tree-label">struct kobject kobj</span></div></li>
            <li><div class="tree-card tone-green"><span class="tree-label">bus / driver / …</span></div></li>
          </ul>
        </li>
      </ul>
    </li>
  </ul>
</div>

所以内核里的“继承”不是语言级别的 is-a,而是**布局级别的 has-a + 偏移还原**。它带来两个后果:

- 优点:零额外元数据、零 RTTI、缓存友好,一个对象可以同时嵌入多个“基类”。
- 缺点:类型安全靠约定和 `static_assert`;一旦传错指针,`container_of` 不会报错,只会得到错误地址。

## 四、设备模型:四张表与一棵树

驱动框架把“对象”进一步抽象成设备模型。核心结构体如下:

| 结构体 | 定义位置 | 角色 |
|---|---|---|
| `struct device` | `include/linux/device.h:708` | 设备的通用表示,内嵌 `kobject` |
| `struct device_driver` | `include/linux/device/driver.h:100` | 驱动的通用表示,含 `probe/remove` |
| `struct bus_type` | `include/linux/device/bus.h:81` | 总线:匹配规则 `match`,以及可选的 `probe/remove` |
| `struct class` | `include/linux/device/class.h:50` | 用户态视角的设备分类(如 `block`、`net`) |
| `struct kobject` | `include/linux/kobject.h:64` | 引用计数 + sysfs 目录锚点,内含 `kref` |

`struct device`(`include/linux/device.h:708`)的第一行就是 `struct kobject kobj;`。这意味着每个设备天然是一个 sysfs 对象,拥有引用计数和生命周期管理。`kobject` 里还有 `struct kref kref`(`include/linux/kref.h:19`),设备被引用时计数加一,最后一个引用释放时才调用 release。

设备注册的入口非常短(`drivers/base/core.c:3857`):

```c
int device_register(struct device *dev)
{
        device_initialize(dev);
        return device_add(dev);
}
```

`device_add`(`drivers/base/core.c:3645`)做的事情可以概括为:

1. `kobject_add` 把设备挂进 sysfs 层次(`:3701`)
2. 创建 `uevent` 等属性文件
3. `bus_add_device` 把设备挂到总线(`:3720`)
4. 发出 `KOBJ_ADD` uevent,通知用户态
5. `dev_set_ready_to_probe` 后调用 `bus_probe_device`(`:3778`),尝试匹配驱动

注意顺序:设备先“可见”,再“尝试 probe”。这既支持热插拔,也解释了为什么用户态可能在驱动绑定完成前就看到设备。

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/内核驱动框架/driver-model.html' | relative_url }}" loading="lazy" title="Linux 设备模型"></iframe>
  <figcaption>图 2:device / driver / bus / class / kobject / sysfs 的关系。</figcaption>
</figure>

## 五、匹配与 probe:bus->match 决定一切

设备和驱动是两条独立的注册路径,真正把它们撮合在一起的是总线。

驱动注册走 `driver_register`(`drivers/base/driver.c:150`),最终在总线上遍历设备并尝试绑定;设备注册走 `device_add` → `bus_probe_device`(`drivers/base/bus.c:630`),最终也走到同一套 probe 逻辑。匹配的公共入口是 `driver_match_device`(`drivers/base/base.h:172`):

```c
static inline int driver_match_device(const struct device_driver *drv,
                                      struct device *dev)
{
        return drv->bus->match ? drv->bus->match(dev, drv) : 1;
}
```

也就是说,**匹配规则由总线实现**,核心不关心具体细节。不同总线给出不同实现:

- `platform_match`(`drivers/base/platform.c:1437`):先设备树,再 ACPI,再 `id_table`,最后按名字匹配
- `pci_bus_match`(`drivers/pci/pci-driver.c:1599`):用 `pci_match_device` 查 vendor/device/class 等 ID 表
- 设备树:`of_match_device`(`drivers/of/device.c:25`)按 `compatible` 匹配
- ACPI:`acpi_driver_match_device` 按 `_HID`/`_CID` 匹配

匹配成功后进入 `really_probe`(`drivers/base/dd.c:653`),这是整个驱动模型的核心。节选关键步骤:

```c
static int really_probe(struct device *dev, const struct device_driver *drv)
{
        ...
        if (!list_empty(&dev->devres_head)) {
                dev_crit(dev, "Resources present before probing\n");
                ret = -EBUSY;
                goto done;
        }

re_probe:
        device_set_driver(dev, drv);

        ret = pinctrl_bind_pins(dev);
        if (ret)
                goto pinctrl_bind_failed;

        if (dev->bus->dma_configure) {
                ret = dev->bus->dma_configure(dev);
                if (ret)
                        goto pinctrl_bind_failed;
        }

        ret = driver_sysfs_add(dev);
        ...
        ret = call_driver_probe(dev, drv);
        if (ret) {
                ...
                ret = -ret;
                goto probe_failed;
        }

        ret = device_add_groups(dev, drv->dev_groups);
        ...
        driver_bound(dev);
        ...
probe_failed:
        driver_sysfs_remove(dev);
sysfs_failed:
        bus_notify(dev, BUS_NOTIFY_DRIVER_NOT_BOUND);
        if (dev->bus && dev->bus->dma_cleanup)
                dev->bus->dma_cleanup(dev);
pinctrl_bind_failed:
        device_links_no_driver(dev);
        device_unbind_cleanup(dev);
done:
        return ret;
}
```

几个细节值得注意:

- **probe 前 devres 必须为空**:如果设备在 probe 前就挂了资源,说明生命周期已经错乱,直接 `-EBUSY`。
- **probe 分派是二级的**:`call_driver_probe`(`drivers/base/dd.c:622`)先看 `bus->probe`,没有才用 `drv->probe`。这允许总线统一包装探测流程。
- **失败路径是标签化的逆序清理**:`probe_failed` → `sysfs_failed` → `pinctrl_bind_failed` → `device_unbind_cleanup`,每一层只负责自己申请的东西。
- **`-EPROBE_DEFER` 不是失败**:表示依赖还没就绪,设备会被放进 deferred probe 列表,稍后重试(`driver_probe_device` 里处理,`drivers/base/dd.c:893`)。

`driver_bound`(`drivers/base/dd.c:447`)完成最后的绑定:把设备挂到驱动的设备列表、建立 sysfs 链接、发出 `KOBJ_BIND` 通知。至此,`dev->driver` 有值,probe 成功。

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/内核驱动框架/driver-bind-probe.html' | relative_url }}" loading="lazy" title="驱动匹配与 probe 流程"></iframe>
  <figcaption>图 3:从设备/驱动注册到 bus match、really_probe 与绑定的完整流程。</figcaption>
</figure>

## 六、devres:设备作用域的 RAII

C 没有析构函数,传统内核代码靠 `goto` 标签逆序清理。设备驱动更麻烦:probe 里可能申请内存、映射寄存器、申请中断、创建 workqueue,任何一步失败都要把之前申请的全部释放。`devres`(device resource management)把这件事自动化了。

它的数据结构很简单:每个资源节点挂在 `dev->devres_head` 上。`devres_add`(`drivers/base/devres.c:277`)最终调用 `devres_node_add`,后者用 `list_add_tail` 尾插(`drivers/base/devres.c:158`)。释放时 `release_nodes`(`drivers/base/devres.c:540`)用 `list_for_each_entry_safe_reverse` **逆序遍历**:

```c
static void release_nodes(struct device *dev, struct list_head *todo)
{
        struct devres_node *node, *tmp;

        list_for_each_entry_safe_reverse(node, tmp, todo, entry) {
                devres_log(dev, node, "REL");
                node->release(dev, node);
                free_node(node);
        }
}
```

先注册后释放,正是栈式析构的语义。`devres_release_all`(`drivers/base/devres.c:558`)负责把所有节点摘下来交给 `release_nodes`:

```c
int devres_release_all(struct device *dev)
{
        unsigned long flags;
        LIST_HEAD(todo);
        int cnt;

        if (WARN_ON(dev->devres_head.next == NULL))
                return -ENODEV;
        if (list_empty(&dev->devres_head))
                return 0;

        spin_lock_irqsave(&dev->devres_lock, flags);
        cnt = remove_nodes(dev, dev->devres_head.next, &dev->devres_head, &todo);
        spin_unlock_irqrestore(&dev->devres_lock, flags);

        release_nodes(dev, &todo);
        return cnt;
}
```

它由 `device_unbind_cleanup`(`drivers/base/dd.c:594`)在解绑/探测失败时调用(`:598`),也会在设备释放时调用(`drivers/base/core.c:2630`)。也就是说,**只要资源是用 `devm_*` 申请的,驱动就不需要在错误路径和 remove 路径手动释放**。

典型的三个托管资源:

| API | 定义位置 | 释放动作 |
|---|---|---|
| `devm_kmalloc` | `drivers/base/devres.c:943` | `kfree` |
| `devm_ioremap` | `lib/devres.c:72` | `iounmap` |
| `devm_request_irq` | `include/linux/interrupt.h:220` | `free_irq` |
| `devm_add_action` | `drivers/base/devres.c:790` | 自定义回调 |

以 `devm_kmalloc`(`drivers/base/devres.c:943`)为例:

```c
void *devm_kmalloc(struct device *dev, size_t size, gfp_t gfp)
{
        struct devres *dr;

        if (unlikely(!size))
                return ZERO_SIZE_PTR;

        dr = alloc_dr(devm_kmalloc_release, size, gfp, dev_to_node(dev));
        if (unlikely(!dr))
                return NULL;

        devres_set_node_dbginfo(&dr->node, "devm_kzalloc_release", size);
        devres_add(dev, dr->data);
        return dr->data;
}
```

分配时把 release 回调一起记在节点里,返回给驱动的是 `dr->data`。驱动拿到的指针和普通 `kmalloc` 一样可用,但它背后多了一个“设备释放时自动 `kfree`”的约定。

需要强调:**devres 是设备作用域的 RAII,不是函数作用域的 RAII**。它不会在某个函数返回时自动释放,而是在设备解绑或销毁时统一释放。因此:

- 短生命周期、函数内临时资源仍应手动释放或使用 `__free`/cleanup 机制
- 长期绑定到设备的资源才适合 `devm_*`
- 在 probe 成功后再手动 `devm_kfree` 通常意味着设计有问题

<figure class="diagram">
  <iframe src="{{ '/linux-arch-dia/内核驱动框架/devres-lifecycle.html' | relative_url }}" loading="lazy" title="devres 生命周期"></iframe>
  <figcaption>图 4:devres 的注册、逆序释放与 probe 失败回滚。</figcaption>
</figure>

## 七、platform / PCI / 设备树 / ACPI:同一套骨架

理解了 `device`、`driver`、`bus_type`、`really_probe`,再看各种“总线”就只是换皮:

| 接入方式 | 设备从哪来 | 驱动注册 | 匹配依据 |
|---|---|---|---|
| platform | 平台代码、设备树、ACPI 展开 | `platform_driver_register`(`drivers/base/platform.c:989`) | `platform_match` |
| PCI | PCI 枚举 | `__pci_register_driver`(`drivers/pci/pci-driver.c:1528`) | `pci_bus_match` |
| 设备树 | `of_platform_populate`(`drivers/of/platform.c:443`) 解析 DT | 同上 platform | `compatible` |
| ACPI | ACPI 命名空间枚举 | 同上 platform 或 ACPI 驱动 | `_HID`/`_CID` |

`platform_bus_type`(`drivers/base/platform.c:1578`)和 `pci_bus_type`(`drivers/pci/pci-driver.c:1790`)都是 `struct bus_type` 的实例。它们提供自己的 `match`、可选的 `probe`、`uevent` 等回调,然后复用 `really_probe`、`devres`、sysfs、电源管理。

设备树和 ACPI 并没有另起炉灶,它们只是**改变了“设备对象从哪里来”和“match 表怎么读”**。一旦 `struct device` 被创建并注册,后面的绑定流程完全相同。这就是设备模型的价值:把“发现硬件”和“绑定驱动”解耦。

## 八、module_init / module_exit 与热插拔

驱动的入口通常写成:

```c
static int __init mydrv_init(void)
{
        return platform_driver_register(&mydrv_driver);
}

static void __exit mydrv_exit(void)
{
        platform_driver_unregister(&mydrv_driver);
}

module_init(mydrv_init);
module_exit(mydrv_exit);
```

`module_init` 在 `include/linux/module.h:89` 展开为 `__initcall(x)`,`module_exit`(`:101`)展开为 `__exitcall(x)`。内建驱动在启动时按 initcall 级别调用,模块则在 `insmod` 时调用。

热插拔的两条路径最终汇合:

```text
设备出现:
  device_register → device_add → bus_probe_device
    → device_initial_probe → __device_attach
      → bus_for_each_drv → __driver_attach → driver_probe_device → really_probe

驱动加载:
  driver_register → bus_add_driver → driver_attach
    → bus_for_each_dev → __driver_attach → driver_probe_device → really_probe
```

`driver_attach`(`drivers/base/dd.c:1315`)遍历总线上的设备,`bus_probe_device`(`drivers/base/bus.c:630`)遍历总线上的驱动,二者在 `really_probe` 汇合。移除时走 `device_release_driver`(`drivers/base/dd.c:1396`)→ `__device_release_driver`(`:1326`)→ `drv->remove` → `device_unbind_cleanup` → `devres_release_all`。

sysfs 还提供 `bind`/`unbind` 文件(`drivers/base/bus.c:235`、`:258`,由 `DRIVER_ATTR_IGNORE_LOCKDEP` 创建),允许在用户态手动解绑/重绑驱动。这是调试驱动、验证 probe 失败路径的常用手段。

## 九、设计精妙点:最少机制,最大复用

把这套框架压缩一下,它只用了四种“语言之外”的机制:

1. **结构体嵌入**实现组合与“继承”
2. **函数指针表**实现多态
3. **`container_of`**实现从基类指针回到派生对象
4. **引用计数 + 资源链表**实现生命周期管理

它的收益是巨大的:

- 新增总线/驱动/文件系统,几乎不改核心代码,只填表
- 同一套 probe、sysfs、电源管理、devres 被所有子系统复用
- const ops 表可共享,对象只多一个指针,内存开销可控

代价也很明显:

- **没有编译期接口检查**:填错函数签名,编译器不一定报错
- **`container_of` 可能静默算错**:类型系统帮不上忙
- **生命周期靠约定**:谁申请谁释放、何时能睡眠、probe 失败如何回滚,都要靠文档和 review
- **没有真正的析构函数**:devres 只是“设备作用域”的近似

和 C++/Rust 对比:

| 能力 | C + 内核约定 | C++ | Rust |
|---|---|---|---|
| 多态 | ops 表 + 函数指针 | `virtual` + vtable | `trait` + 动态/静态分发 |
| 继承 | 结构体嵌入 + `container_of` | 类继承 | 组合 + trait |
| 向下转型 | `container_of`(无检查) | `dynamic_cast`(有 RTTI) | `downcast`(有类型检查) |
| 析构 | devres / 手动标签 | 析构函数 | `Drop`(确定性) |
| 生命周期 | kref + 约定 | RAII + 智能指针 | 所有权 + 借用检查 |
| 运行时开销 | 一个 ops 指针 | 一个 vptr | 单态化或胖指针 |

Rust for Linux 之所以能接入同一套设备模型,正是因为它用 trait 表达 `file_operations`、用 `Drop` 表达资源释放,同时保留了 C 侧的布局与 ABI。换句话说,**内核的面向对象是“数据布局 + 约定”,语言只是不同的表达方式**。

## 十、常见误解

- **“container_of 是运行时类型转换”**:它只是减去偏移,没有任何检查;传错类型会得到错误地址。
- **“ops 里没实现的函数会崩”**:调用方通常先判空或提供默认实现,`NULL` 表示“不支持”。
- **“devres 等于 C++ 析构函数”**:它绑定设备生命周期,不是任意作用域;函数返回不会触发释放。
- **“probe 返回错误就是驱动坏了”**:`-EPROBE_DEFER` 是正常的依赖等待,会被延迟重试。
- **“设备和驱动靠名字匹配”**:名字只是 platform 的最后兜底;设备树、ACPI、PCI 都各有 ID 表。
- **“module_init 一定在设备之前”**:顺序取决于 initcall 级别和注册时序,热插拔下设备可能先于驱动出现。

## 相关图示

- [Linux 设备模型]({{ '/linux-arch-dia/内核驱动框架/driver-model.html' | relative_url }})
- [驱动匹配与 probe 流程]({{ '/linux-arch-dia/内核驱动框架/driver-bind-probe.html' | relative_url }})
- [devres 生命周期]({{ '/linux-arch-dia/内核驱动框架/devres-lifecycle.html' | relative_url }})
- [file_operations 动态分派]({{ '/linux-arch-dia/内核驱动框架/file-operations-dispatch.html' | relative_url }})
- [总线与驱动模型]({{ '/linux-arch-dia/设备驱动/bus-driver-model.html' | relative_url }})
- [VFS 架构]({{ '/linux-arch-dia/文件系统/vfs-architecture.html' | relative_url }})

> 源码基线:Linux `d487237`(v7.4.0-rc1)。行号会随内核版本漂移,以图集仓库重新 finalize 后的结果为准。
