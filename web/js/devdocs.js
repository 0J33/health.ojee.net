/* The developer pages (server/devdocs.js): a copy button on each code block,
   and the contents folded on a phone. No module: a plain deferred script. */
(function () {
  if (window.matchMedia('(max-width: 900px)').matches) {
    var toc = document.querySelector('.dd-toc');
    if (toc) toc.removeAttribute('open');
  }
  var blocks = document.querySelectorAll('.dd-code');
  for (var i = 0; i < blocks.length; i += 1) {
    (function (pre) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'dd-copy'; b.textContent = 'Copy';
      b.addEventListener('click', function () {
        var text = pre.querySelector('code').textContent;
        var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { b.textContent = 'Select and copy'; });
        else b.textContent = 'Select and copy';
      });
      pre.appendChild(b);
    })(blocks[i]);
  }
})();
