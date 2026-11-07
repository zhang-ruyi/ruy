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
})();
