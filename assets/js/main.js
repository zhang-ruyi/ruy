(function () {
  'use strict';

  // Theme toggle
  var root = document.documentElement;
  var toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('ruy-theme', next); } catch (e) {}
    });
  }

  // Mobile nav
  var navToggle = document.getElementById('nav-toggle');
  var nav = document.getElementById('nav');
  if (navToggle && nav) {
    navToggle.addEventListener('click', function () {
      nav.classList.toggle('open');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') nav.classList.remove('open');
    });
  }

  // Reveal on scroll
  var revealables = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px' });
    revealables.forEach(function (el) { io.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add('is-visible'); });
  }

  // Post category filter
  var list = document.getElementById('post-list');
  var chips = document.querySelectorAll('.filters .chip');
  if (list && chips.length) {
    var apply = function (filter) {
      chips.forEach(function (c) {
        c.classList.toggle('active', c.dataset.filter === filter);
      });
      var shown = 0;
      list.querySelectorAll('.post-item').forEach(function (item) {
        var cats = (item.dataset.cats || '').split(/\s+/);
        var ok = filter === 'all' || cats.indexOf(filter) !== -1;
        item.style.display = ok ? '' : 'none';
        if (ok) shown++;
      });
      var empty = document.getElementById('filter-empty');
      if (empty) empty.style.display = shown ? 'none' : '';
      try {
        var url = new URL(window.location.href);
        if (filter === 'all') url.searchParams.delete('cat');
        else url.searchParams.set('cat', filter);
        window.history.replaceState(null, '', url);
      } catch (e) {}
    };

    chips.forEach(function (chip) {
      chip.addEventListener('click', function () { apply(chip.dataset.filter); });
    });

    var params = new URLSearchParams(window.location.search);
    apply(params.get('cat') || 'all');
  }
  // Article TOC + reading progress
  var article = document.querySelector('.article-layout .prose');
  var toc = document.getElementById('article-toc');
  var tocList = document.getElementById('article-toc-list');
  var tocMeta = document.getElementById('article-toc-meta');
  var progressBar = document.getElementById('reading-progress-bar');

  if (article && toc && tocList) {
    var headings = Array.prototype.filter.call(
      article.querySelectorAll('h2, h3'),
      function (h) { return h.textContent.trim() && !h.closest('figure'); }
    );

    if (headings.length < 2) {
      toc.classList.add('is-empty');
    } else {
      var slugify = function (text, i) {
        var base = text.trim().toLowerCase()
          .replace(/[^\w\u4e00-\u9fff]+/g, '-')
          .replace(/^-+|-+$/g, '');
        return 'sec-' + (base ? base.slice(0, 40) : i);
      };
      var used = {};
      headings.forEach(function (h, i) {
        var id = h.id || slugify(h.textContent, i);
        if (used[id]) id = id + '-' + i;
        used[id] = true;
        h.id = id;
      });

      var h2Count = 0;
      var currentSub = null;
      headings.forEach(function (h) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '#' + h.id;
        a.textContent = h.textContent.trim();
        li.appendChild(a);
        if (h.tagName === 'H2') {
          li.className = 'toc-h2';
          h2Count++;
          tocList.appendChild(li);
          var sub = document.createElement('ol');
          sub.className = 'toc-sub';
          li.appendChild(sub);
          currentSub = sub;
        } else if (currentSub) {
          li.className = 'toc-h3';
          currentSub.appendChild(li);
        } else {
          li.className = 'toc-h2';
          h2Count++;
          tocList.appendChild(li);
        }
      });
      tocList.querySelectorAll('.toc-sub').forEach(function (sub) {
        if (!sub.children.length) sub.remove();
      });

      var text = article.textContent || '';
      var cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      var words = (text.match(/[A-Za-z0-9_]+/g) || []).length;
      var minutes = Math.max(1, Math.round((cjk + words * 1.5) / 400));
      if (tocMeta) tocMeta.textContent = h2Count + ' 节 · 约 ' + minutes + ' 分钟';

      var links = [];
      tocList.querySelectorAll('a').forEach(function (a) {
        links.push(a);
        a.addEventListener('click', function (e) {
          var href = a.getAttribute('href');
          var target = document.getElementById(href.slice(1));
          if (!target) return;
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          if (window.history && history.replaceState) history.replaceState(null, '', href);
        });
      });

      var activate = function (id) {
        links.forEach(function (a) {
          a.classList.toggle('active', a.getAttribute('href') === '#' + id);
        });
      };

      var headerEl = document.querySelector('.site-header');
      var headerH = headerEl ? headerEl.offsetHeight : 64;
      var onScrollActive = function () {
        var offset = headerH + 90;
        var current = headings[0].id;
        headings.forEach(function (h) {
          if (h.getBoundingClientRect().top <= offset) current = h.id;
        });
        activate(current);
      };
      window.addEventListener('scroll', onScrollActive, { passive: true });
      onScrollActive();

      var onProgress = function () {
        var doc = document.documentElement;
        var max = doc.scrollHeight - window.innerHeight;
        var pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0;
        if (progressBar) progressBar.style.width = pct.toFixed(2) + '%';
      };
      window.addEventListener('scroll', onProgress, { passive: true });
      onProgress();
    }
  }

  var topLink = document.getElementById('article-top');
  if (topLink) {
    topLink.addEventListener('click', function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
})();
