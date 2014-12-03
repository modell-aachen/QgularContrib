;(function ($, _, document, window, undefined) {
  'use strict';

  /* qbind: one-way bind system resistant against code injection
   *
   * Core tenets:
   * (1) For customization, having to put HTML snippet template inside
   *     JavaScript code is infeasible, ruling out Underscore's template
   *     system
   *
   * (2) Having to bind event handlers and the like inside the HTML is dirty
   *     and violates separation of concerns. Frameworks like Angular don't
   *     easily support binding events from within scripts, and make it hard
   *     to access the model from vanilla JS events.
   *
   * (3) Two-way binding helps with a very small class of use cases and does
   *     not provide any notable benefits for more transaction-oriented user
   *     interfaces, but adds significant complexity to the code.
   *
   * Our minimalistic approach: bindings are applied by calling a jQuery
   * function on the top-level element. The function collects binding
   * specifications (bindspecs) from that element and its children, and
   * applies the variable bindings specified in them.
   *
   * Bindspecs are specified in a "qbind" attribute; multiple bindspecs in a
   * single attribute are comma-separated. Each bindspec is of the form
   *     [CSS selector //][attribute:]variable
   * where "[]" means "optional". If a CSS selector is given, the binding is
   * applied to all matching child elements; if it is omitted, the binding is
   * applied to the element the qbind attribute is set on. If an attribute
   * name is given, the bindings sets the value of that attribute in the node;
   * otherwise the text content of the node is set.
   *
   * The first time qbind is applied, the qbind attributes are removed from
   * the DOM, but future calls to qbind will still work.
   *
   * Usage example:
   * (HTML)
   * <div id="foo" qbind=".title // title, data-url: url">
   *   <div class="title"></div>
   *   <div qbind="content"></div>
   * </div>
   *
   * (Script)
   * $('#foo').qbind({title: "My title", url: "//example.org",
   *   content: "The quick brown fox jumps over the lazy dog"});
   *
   * (Result)
   * <div id="foo" data-url="//example.org">
   *   <div class="title">My title</div>
   *   <div>The quick brown fox jumps over the lazy dog</div>
   * </div>
   */
  $.fn.qbind = function(data, mapper, attr) {
    if (!attr) { attr = 'qbind'; }
    this.each(function() {
      var $e = $(this);
      var binds = $.data(this, 'qbind');

      // Collect bindspecs
      if (!binds) {
        binds = [];
        var $nodes = $e.find('['+attr+']').addBack('['+attr+']');
        $nodes.each(function() {
          var $n = $(this);
          var spec = $n.attr(attr).split(/\s*,\s*/);
          $.each(spec, function() {
            var bindspec = this,
              $target = $n,
              selector = this.match(/^(.*)\s*\/\/\s*(.*)$/);
            if (selector) {
              bindspec = selector[2];
              $target = $n.find(selector[1]);
            }
            var k = bindspec.match(/^(.*)\s*:\s*(.*)$/);
            if (!k) {
              k = [null, '_text', bindspec];
            }
            if (!k[2].match(/^\w+(\.\w+)*$/)) {
              throw "Invalid qbind spec: bad value spec for '"+ k[2] +"'";
            }
            if (k[1].match(/^on/)) {
              throw "Refusing to qbind to an on* attribute ('"+ k[1] +"')";
            }
            if ($target.is('script')) {
              throw "Refusing to qbind into a script tag";
            }
            binds.push({'attr': k[1], element: $target, slot: k[2]});
          });
          $n.removeAttr(attr);
        });
        $.data(this, 'qbind', binds);
      }

      // Allow parsing qbinds without actually applying them
      if (!data) { return; }

      // Apply bindings
      $.each(binds, function() {
        var slotpath = this.slot.split(/\./);
        var v = data;
        while (slotpath.length) {
          v = v[slotpath.shift()];
          if (v === null || v === undefined) { break; }
        }
        if (mapper[this.slot]) {
          v = mapper[this.slot](v);
        }
        if (v === null || v === undefined) { v = ''; }
        if (v instanceof QWidget) {
          this.element.empty().append(v.$e);
        }
        if (this.attr === '_text') {
          this.element.text(v);
        } else {
          this.element.attr(this.attr, v);
        }
      });
    });
  };

  /* qtemplate: template engine based on qbind
   *
   * * Templates are defined inline, in the place where they will be used
   *   later. A mechanism to reuse a template in multiple places in the DOM
   *   could be added later.
   *
   * * The templates are detached from the document in a "compile" step, and
   *   instead associated with the parent element in an out-of-band fashion.
   *   The parent element is called the "container".
   *
   * * A node can contain multiple different templates; each template's
   *   "data-qtemplate" attribute specifies an ID for that template. IDs are
   *   not global; they only serve to distinguish sibling templates.
   *
   * * An "add" step spawns a new instance of the template, applies value
   *   bindings, and appends it to the container. This can be used both for
   *   rendering a single thing or a collection of things (by calling "add"
   *   multiple times).
   *
   * * Bindings are specified within the template, using the "qbind"
   *   attribute. For historical reasons, if a "qt-bind" attribute exists
   *   anywhere within the template, "qt-bind" attributes are used instead.
   *
   * Usage example:
   * (HTML)
   * <ul class="searchresults">
   *   <li data-qtemplate="result"><a qbind="href: url, title"></a>
   *     <div class="summary" qbind="summary">
   *   </li>
   *   <li data-qtemplate="noresult" class="noresult">No results found</li>
   * </ul>
   *
   * (Script)
   * var $container = $('.searchresults');
   * // $('[data-qtemplate]').qtemplate('compile');
   * // the compilation is handled automatically for all data-qtemplate
   * // elements when utils's bind method is called
   * // ...
   * $container.empty();
   * // ...
   * $.each(results, function() {
   *   $container.qtemplate('add', $.extend({
   *     _type: 'result'
   *   }, this));
   *   // (_type is not necessary if not specified in the template)
   * });
   */
  $.fn.qtemplate = function(action, options) {
    this.each(function() {
      var self = $(this);
      var type;
      if (action === 'compile') {
        type = self.data('qtemplate');
        if (!type || type === '' || type === 'data-qtemplate') { type = 'main'; }
        $.data(self.parent()[0], 'qtemplate.'+type, self);
        self.removeData('qtemplate').removeAttr('data-qtemplate').detach();
        return;
      }

      var opts = $.extend({
        _type: 'main'
      }, options);
      var e = self[0];
      type = opts._type;
      delete opts._type;
      var $tmpl = $.data(e, 'qtemplate.'+type);
      if (action === 'get') {
        return $tmpl;
      }
      if (!$tmpl) { return; }

      $tmpl = $tmpl.clone();
      if (action === 'add') {
        var attr = 'qbind';
        if ($tmpl.find('[qt-bind]').addBack('[qt-bind]').length) {
          attr = 'qt-bind';
        }
        $tmpl.qbind(options, {}, attr);
        self.append($tmpl);
        return $tmpl;
      }
    });
  };

  $(function() {
    $('[data-qtemplate]').qtemplate('compile');
  });

  // TODO: two-stage!
  // 1) function to create a subclass containing the template DOM node
  // 2) subclass should do the actual lifting
  // also: assign event handlers in stage 1
  window.QWidget = function(o) {
    var self = this;
    if (o.detach !== false) {
      o.$e.detach();
    }
    this.$e = o.$e;
    this.children = [];
    this.childrenKeys = {};
    this.id = o.id;
    this.data = o.data || {};

    // Container for children
    if (o.container) { this.$c = $(o); }

    this.get = function(k) {
      return this.data[k];
    };
    this.set = function(data) {
      $.each(data, function(k,v) {
        self.data[k] = v;
      });
      this.$e.qbind(self.data);
    };

    this.vanish = function() {
      if (this.parent) {
        this.parent.remove(this);
      } else {
        this.$e.remove();
      }
    };

    // Sub-collection functions

    this.add = function(data, pos) {
      if (data.parent && data.parent !== this) {
        throw "Tried to add a QWidget to a second parent; not possible";
      }
      if (data.id && this.childrenKeys[data.id]) {
        // Simply ignore dupes
        return;
      }
      data.parent = this;
      if (data.id) { this.childrenKeys[data.id] = data; }
      if (!pos) { pos = this.children.length; }
      if (pos < 0) { pos = this.children.length + (pos-1); } // -1 = after last elem, -2 = before last elem, ...
      if (pos === this.children.length) {
        this.$c.append(data.$e);
      } else {
        this.$c.eq(pos).before(data.$e);
      }
      this.children.splice(pos, 0, data);

    };
    this.remove = function(idx) {
      var d = idx;
      if (typeof idx === 'object') {
        this.children.splice(this.children.indexOf(d), 1);
      } else {
        d = this.children.splice(idx, 1);
        d = d[0];
      }
      if (d.id) { delete this.childrenKeys[d.id]; }
      d.remove();
    };
    this.removeById = function(id) {
      var d = this.childrenKeys[id];
      if (!d) { return; }
      var idx = this.children.indexOf(d);
      this.children.splice(idx, 1);
      delete this.childrenKeys[d.id];
    };

    if (o.parent) {
      o.parent.add(this);
    }
    this.set({});
  };
}(jQuery, window._, window.document, window));
