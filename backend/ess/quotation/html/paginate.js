/* Flows the quotation into A4 pages.
   Every page gets the letterhead, stamp, draft mark and "Page x of y" from the #ess-page
   template. Item tables split between rows with the header repeated; headings stay with what
   follows them. Text stops above the company stamp, as on the builder's pages, except the
   closing + signature block, which sits beside the stamp once, at the bottom of the last page.
   Resolves window.essReady and sets window.__essPaginated when the document can be printed. */
(function () {
  'use strict';
  var doc = document;
  var MM = 96 / 25.4;
  doc.documentElement.classList.remove('no-js');
  doc.documentElement.classList.add('js');

  function px(value) { return parseFloat(value) || 0; }
  function toArray(list) { return Array.prototype.slice.call(list || []); }

  function contentLimit(box) {
    return box.getBoundingClientRect().bottom - px(getComputedStyle(box).paddingBottom);
  }

  // Lowest point ordinary text may reach: just above a stamp that sits in the lower part of the box.
  function textLimit(box) {
    var limit = contentLimit(box);
    var stamp = box.parentNode.querySelector('.page-stamp');
    if (stamp && stamp.style.display !== 'none') {
      var top = stamp.getBoundingClientRect().top - 2 * MM;
      if (top < limit && top > limit - 60 * MM) limit = top;
    }
    return limit;
  }

  // The closing may run a little past the text box, as the builder's letters do (the footer
  // band still starts well below it).
  var CLOSING_ALLOWANCE = 4 * MM;

  function fits(box) {
    var last = box.lastElementChild;
    if (!last) return true;
    var bottom = last.getBoundingClientRect().bottom + px(getComputedStyle(last).marginBottom);
    var limit = last.hasAttribute('data-closing') ? contentLimit(box) + CLOSING_ALLOWANCE : textLimit(box);
    return bottom <= limit + 0.5;
  }

  function stampOverrides(root) {
    try { return JSON.parse(root.getAttribute('data-stamp-pages') || '{}') || {}; } catch (e) { return {}; }
  }

  function paginate() {
    var flow = doc.getElementById('ess-flow');
    var root = doc.getElementById('ess-pages');
    var tpl = doc.getElementById('ess-page');
    var overrides = stampOverrides(root);
    var pages = [];
    var box = null;
    var lead = 0; // furniture (continuation line) at the top of the current text box

    function addPage(annex) {
      var page = tpl.content.firstElementChild.cloneNode(true);
      var stamp = page.querySelector('.page-stamp');
      var custom = overrides[String(pages.length + 1)];
      if (stamp && custom) {
        stamp.style.display = custom.show === false ? 'none' : '';
        if (typeof custom.x === 'number') stamp.style.left = custom.x + 'mm';
        if (typeof custom.y === 'number') stamp.style.top = custom.y + 'mm';
        if (typeof custom.width === 'number') stamp.style.width = custom.width + 'mm';
      }
      root.appendChild(page);
      pages.push(page);
      box = page.querySelector('.content');
      lead = 0;
      if (annex) {
        page.classList.add('reference-annex');
      } else if (pages.length > 1) {
        var cont = doc.createElement('div');
        cont.className = 'continuation';
        cont.textContent = ' ';
        box.appendChild(cont);
        lead = 1;
      }
    }
    function contentCount() { return box.children.length - lead; }
    function carryHeadings() { // trailing headings move on with the block they introduce
      var carried = [];
      while (contentCount() > 1 && box.lastElementChild.hasAttribute('data-keep-next')) {
        carried.unshift(box.removeChild(box.lastElementChild));
      }
      return carried;
    }
    function nextPage(carried) {
      addPage();
      carried.forEach(function (node) { box.appendChild(node); });
    }

    function tableShell(table) {
      var colgroup = table.querySelector('colgroup');
      var head = table.tHead;
      return function () {
        var node = table.cloneNode(false);
        if (colgroup) node.appendChild(colgroup.cloneNode(true));
        if (head) node.appendChild(head.cloneNode(true));
        var body = doc.createElement('tbody');
        node.appendChild(body);
        return { node: node, holder: body };
      };
    }
    function listShell(list) {
      return function () {
        var node = list.cloneNode(false);
        return { node: node, holder: node };
      };
    }

    // What travels with a closing block that no longer fits, so the signature never stands
    // alone on a page: a short block whole (with its heading), else its last two rows / items.
    function carryTail() {
      if (contentCount() < 2) return [];
      var last = box.lastElementChild;
      var mode = last.getAttribute('data-split');
      var parts = mode === 'rows' ? (last.tBodies[0] ? last.tBodies[0].rows : []) : mode === 'children' ? last.children : null;
      if (parts && parts.length > 4) {
        var shell = (mode === 'rows' ? tableShell(last) : listShell(last))();
        var tail = toArray(parts).slice(-2);
        tail.forEach(function (part) { shell.holder.appendChild(part); });
        return [shell.node];
      }
      var keep = 0; // blocks that would remain on this page besides headings
      toArray(box.children).slice(lead, -1).forEach(function (node) {
        if (!node.hasAttribute('data-keep-next')) keep += 1;
      });
      if (keep === 0) return [];
      box.removeChild(last);
      var carried = carryHeadings();
      carried.push(last);
      return carried;
    }

    function placeClosing(block) {
      box.appendChild(block);
      if (fits(box)) return;
      block.classList.add('tight');
      if (fits(box)) return;
      block.classList.remove('tight');
      box.removeChild(block);
      if (contentCount() === 0) { box.appendChild(block); return; }
      nextPage(carryTail());
      box.appendChild(block);
    }

    function placeAtomic(block) {
      box.appendChild(block);
      if (fits(box)) return;
      box.removeChild(block);
      if (contentCount() === 0) { box.appendChild(block); return; } // taller than a page: keep it
      nextPage(carryHeadings());
      box.appendChild(block);
    }

    function splitInto(makeShell, parts) {
      var shell = makeShell();
      var placed = 0;
      box.appendChild(shell.node);
      parts.forEach(function (part) {
        shell.holder.appendChild(part);
        if (fits(box)) { placed += 1; return; }
        shell.holder.removeChild(part);
        if (placed === 0) {
          // Not even the first part fits here: the whole block (and its heading) moves on.
          box.removeChild(shell.node);
          if (contentCount() > 0) nextPage(carryHeadings()); // else: a part taller than a page stays
          box.appendChild(shell.node);
        } else {
          addPage(); // continue on a fresh page with a fresh shell (table header repeated)
          shell = makeShell();
          box.appendChild(shell.node);
        }
        shell.holder.appendChild(part);
        placed = 1;
      });
      if (!parts.length && !fits(box) && contentCount() > 1) {
        box.removeChild(shell.node);
        nextPage(carryHeadings());
        box.appendChild(shell.node);
      }
    }

    addPage();
    toArray(flow.children).forEach(function (block) {
      var mode = block.getAttribute('data-split');
      if (block.hasAttribute('data-closing')) {
        placeClosing(block);
      } else if (mode === 'rows') {
        splitInto(tableShell(block), toArray(block.tBodies[0] && block.tBodies[0].rows));
      } else if (mode === 'children') {
        splitInto(listShell(block), toArray(block.children));
      } else {
        placeAtomic(block);
      }
    });
    flow.parentNode.removeChild(flow);
    placePhotos();

    // ---- product reference photos (builder ReferencePhotos.fitPlacement) ----
    function placePhotos() {
      var holder = doc.getElementById('ess-photos');
      if (!holder) return;
      var quotationPages = pages.slice();
      var annex = [];
      toArray(holder.children).forEach(function (figure) {
        if (figure.getAttribute('data-mode') !== 'page' || !placeOnPage(figure, quotationPages)) annex.push(figure);
      });
      var count = Math.ceil(annex.length / 2);
      for (var i = 0; i < annex.length; i += 2) {
        addPage(true);
        var title = doc.createElement('h1');
        title.className = 'annex-title';
        title.textContent = holder.getAttribute('data-annex-title');
        var reference = doc.createElement('p');
        reference.className = 'annex-reference';
        reference.textContent = holder.getAttribute('data-annex-prefix') + ' — ' + (i / 2 + 1) + '/' + count;
        var grid = doc.createElement('div');
        grid.className = 'photo-annex-grid';
        annex.slice(i, i + 2).forEach(function (figure) { figure.className = 'photo-annex-card'; grid.appendChild(figure); });
        box.appendChild(title);
        box.appendChild(reference);
        box.appendChild(grid);
      }
      holder.parentNode.removeChild(holder);
    }

    function placeOnPage(figure, quotationPages) {
      var SAFE = { left: 8, top: 48, right: 202, bottom: 264 };
      var number = Math.min(Math.max(1, parseInt(figure.getAttribute('data-page'), 10) || 1), quotationPages.length);
      var page = quotationPages[number - 1];
      var aspect = Math.max(0.05, parseFloat(figure.getAttribute('data-aspect')) || 1);
      var width = Math.min(100, Math.max(25, parseFloat(figure.getAttribute('data-width')) || 55));
      var height = width / aspect;
      if (height > 92) { height = 92; width = height * aspect; }
      var origin = page.getBoundingClientRect();
      var zones = toArray(page.querySelectorAll('.band.head, .band.foot, .wm, .page-stamp, .content > *, .reference-photo-overlay'))
        .filter(function (node) { return getComputedStyle(node).display !== 'none'; })
        .map(function (node) {
          var r = node.getBoundingClientRect();
          return { x: (r.left - origin.left) / MM, y: (r.top - origin.top) / MM, width: r.width / MM, height: r.height / MM };
        })
        .filter(function (zone) { return zone.width > 0 && zone.height > 0; });
      function valid(x, y) {
        if (x < SAFE.left || y < SAFE.top || x + width > SAFE.right || y + height > SAFE.bottom) return false;
        return !zones.some(function (z) {
          return x < z.x + z.width + 1.5 && x + width > z.x - 1.5 && y < z.y + z.height + 1.5 && y + height > z.y - 1.5;
        });
      }
      var maxX = Math.max(SAFE.left, SAFE.right - width), maxY = Math.max(SAFE.top, SAFE.bottom - height);
      var wantX = Math.min(Math.max(parseFloat(figure.getAttribute('data-x')) || 137, SAFE.left), maxX);
      var wantY = Math.min(Math.max(parseFloat(figure.getAttribute('data-y')) || 58, SAFE.top), maxY);
      var spot = valid(wantX, wantY) ? { x: wantX, y: wantY } : null;
      if (!spot) { // the nearest free spot on a 2 mm grid
        var best = null;
        for (var yy = SAFE.top; yy <= maxY + 0.01; yy += 2) {
          for (var xx = SAFE.left; xx <= maxX + 0.01; xx += 2) {
            if (!valid(xx, yy)) continue;
            var distance = (xx - wantX) * (xx - wantX) + (yy - wantY) * (yy - wantY);
            if (!best || distance < best.d) best = { x: xx, y: yy, d: distance };
          }
        }
        spot = best;
      }
      if (!spot) return false; // nowhere free on that page: the annex takes it
      var image = figure.querySelector('img');
      image.className = 'reference-photo-overlay';
      image.style.left = spot.x.toFixed(1) + 'mm';
      image.style.top = spot.y.toFixed(1) + 'mm';
      image.style.width = width.toFixed(1) + 'mm';
      image.style.height = height.toFixed(1) + 'mm';
      page.appendChild(image);
      return true;
    }

    var labels = root.dataset;
    var total = pages.length;
    pages.forEach(function (page, index) {
      var n = index + 1;
      page.setAttribute('data-page', String(n));
      var number = page.querySelector('.page-no');
      if (number) number.textContent = labels.pageWord + ' ' + n + ' ' + labels.ofWord + ' ' + total;
      var cont = page.querySelector('.content > .continuation');
      if (cont) cont.textContent = labels.contPrefix + ' ' + n + '/' + total;
    });
    root.setAttribute('data-pages', String(total));
  }

  function loadFonts() {
    var loads = [];
    if (doc.fonts && doc.fonts.forEach) {
      doc.fonts.forEach(function (face) { loads.push(face.load().catch(function () {})); });
    }
    return Promise.all(loads).then(function () { return doc.fonts ? doc.fonts.ready : null; });
  }
  function decodeImages() {
    return Promise.all(toArray(doc.images).map(function (img) {
      return img.decode ? img.decode().catch(function () {}) : null;
    }));
  }
  function done(error) {
    if (error) window.__essError = String((error && error.message) || error);
    window.__essPaginated = true;
    doc.documentElement.setAttribute('data-paginated', error ? 'error' : 'true');
  }

  window.essReady = loadFonts()
    .then(paginate)
    .then(decodeImages)
    .then(function () { done(); }, done);
})();
