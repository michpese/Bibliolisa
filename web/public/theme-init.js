// Theme vor dem ersten Paint setzen (verhindert Flackern).
(function () {
  try {
    var stored = localStorage.getItem('bibliolisa-theme');
    var dark =
      stored === 'dark' ||
      ((stored === null || stored === 'system') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
