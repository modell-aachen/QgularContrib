;(function ($, _, document, window, undefined) {
  'use strict';

  /* Qgular: the non-MVC framework with its own acronym!
   *
   * Qgular implements the DTW (Data-Transform-Widget) paradigm.
   * There's that acronym we promised.
   *
   * Core tenets:
   * (1) For combining data and markup, having to put HTML snippet template
   *     inside JavaScript code is infeasible if customizing the markup should
   *     be easily possible, ruling out Underscore's template system
   *
   * (2) Having to bind event handlers and the like inside the HTML is dirty,
   *     violates separation of concerns and is likely to create XSS issues.
   *     Existing MV* frameworks don't easily support binding events from
   *     within scripts, and make it hard to access the model from vanilla JS
   *     events.
   *
   * (3) Two-way binding, which is all the rage these days, helps with a very
   *     small class of use cases and does not provide any notable benefits
   *     for more transaction-oriented user interfaces, but adds significant
   *     complexity to the code.
   *
   *
   * The DTW paradigm:
   *
   * Data: an unopinionated, JSON-centric, observable data model; see QData
   * below.
   *
   * Widget: encapsulated pieces of logic that are anchored to a specific node
   * in a nested structure of QDataNode elements, responsible for rendering
   * its subtree of QDataNodes and potentially submitting changes made by the
   * user back to that structure.
   *
   * Transform: each layer/widget can have its own transformed representation
   * of the data. Changes made in one layer (e.g. edits by user) can be kept
   * separate from changes made in another layer (e.g. updates from the
   * server). This is useful to implement transaction logic, among other
   * things.
   *
   * Support for each element of DTW is designed such that simple use cases
   * require little code and the code is easily extended as the complexity of
   * the scenario increases.
   */

  // Support functions: pathspecs {{{
  var pathToChain = function(o, p) {
    var chain = [o];
    var last = o;
    $.each(p, function() {
      if (typeof last[this] !== 'undefined') {
        var next = last[this];
        chain.push(next);
        last = next;
      } else {
        last = undefined;
        return false;
      }
    });
    if (last === undefined) { return undefined; }
    return chain;
  };

  var pathToVal = function(o, p) {
    var chain = pathToChain(o, p);
    if (chain === undefined) { return undefined; }
    return chain.pop();
  };

  var mkpath = function(ref) {
    if (typeof ref === 'string') {
      return ref.split('.');
    }
    return ref;
  };

  var refToVal = function(o, ref) {
    if (o instanceof QWidget) {
      return o.get(ref);
    }
    return pathToVal(o, mkpath(ref));
  };
  // }}}
  // Support function: Object.create polyfill {{{
  // Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/create
  if (typeof Object.create !== 'function') {
    Object.create = (function() {
      var Temp = function() {};
      return function(prototype) {
        if (arguments.length > 1) {
          throw Error('Second argument not supported');
        }
        if (typeof prototype !== 'object') {
          throw Error('Argument must be an object');
        }
        Temp.prototype = prototype;
        var result = new Temp();
        Temp.prototype = null;
        return result;
      };
    })();
  }
  // }}}

  /* qbind: one-way bind system resistant against code injection {{{
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
   * qbind NEVER inserts HTML; it will only insert attributes (except those
   * that can be used to inject script) and text nodes.
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
   *
   * (There is no specific reason for binding title in a different way than
   * content in the HTML example, other than for demonstrating both ways. Pick
   * whatever works best for you.)
   */
  $.fn.qbind = function(data, attr) {
    if (!attr) { attr = 'qbind'; }
    this.each(function() {
      var $e = $(this);
      var binds = $.data(this, 'qbind');

      // Plumbing
      if (data === 'get') { return binds; }

      // Allow code to create the bindings instead of grabbing from DOM
      if (data === 'define') {
        binds = [];
        $.each(attr, function() {
          var elem = this.element;
          // Allows passing: jQuery object, empty selector to select qbind
          // root node; other selector to select descendant
          if (!(elem instanceof jQuery)) {
            if (elem === '') { elem = $e; }
            elem = $e.find(elem);
          }
          binds.push($.extend({}, this, {element: elem}));

        });
        $.data(this, 'qbind', binds);
        return;
      }

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
        var v = refToVal(data, this.slot);
        if (v === null || v === undefined) { v = ''; }
        if (this.attr === '_text') {
          this.element.text(v);
        } else {
          this.element.attr((this.pre ? this.pre : '') + this.attr +
            (this.post ? this.post : ''), v);
        }
      });
    });
  };
  // }}}

  /* qtemplate: template engine based on qbind {{{
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
        $tmpl.qbind(options, attr);
        self.append($tmpl);
        return $tmpl;
      }
    });
  };

  $(function() {
    $('[data-qtemplate]').qtemplate('compile');
  });
  // }}}

  /* qpubsub: signals/slots {{{
   *
   * A mixin for other Q* objects to provide pub/sub mechanics.
   */
  function QPubSub() {
    this._subscribers = {};
  }
  $.extend(QPubSub.prototype, {
    on: function(type, cb) {
      if (!this._subscribers[type]) this._subscribers[type] = [];
      this._subscribers[type].push(cb);
      return this;
    },
    off: function(type, cb) {
      this._subscribers[type] = this._subscribers[type].filter(function(v) {
        return v !== cb;
      });
    },
    _notify: function(type) {
      var self = this;
      var args = arguments.slice(1);
      $.each(this._subscribers[type], function(_idx, sub) {
        sub(self, args);
      });
    }
  });
  // }}} 

  /* qdata: schemaless data model {{{
   *
   * Provides a simple, JSON-centric data model with a minimalistic interface.
   * This consists of objects wrapping around JSON data, and collections for
   * handing multiple sets of data to a component.
   *
   * In addition, all of these objects allow subscribing to data manipulation
   * events ('change' for a JSON wrapper, and additionally 'add' and 'remove'
   * for collections), so that changes in the data can be responded to, e.g.
   * by rendering them in a widget.
   *
   * Usage example:
   *   var par = new QData({
   *     id: 13,
   *     title: "Parsnip",
   *     amount: 2,
   *     unit: "pcs"
   *   });
   *   var oni = new QData({
   *     id: 4,
   *     title: "Onion",
   *     amount: 3,
   *     unit: "pcs",
   *     remark: "Steam viciously"
   *   });
   *   var ingredients = new QDataList([par, oni]);
   *   ingredients.on('add', function(_container, i) {
   *     Cooking.Pot.insert(i.data());
   *   });
   *   ingredients.on('change', function(_container, i) {
   *     Cooking.Chef.notify('change_ingredient', i.data());
   *   });
   *   ingredients.add(new QData({
   *     (...)
   *   });
   *   oni.set({amount: 4, remark: QDeleteThis()});
   *
   */
  function QDataNode() {
    QPubSub.call(this);
    this._parents = [];
  }
  $.extend(QDataNode.prototype, {
    _addParent: function(obj) {
      this._parents.push(obj);
    },
    _removeParent: function(obj) {
      this._parents = this._parents.filter(function(v) { return v !== obj; });
    },
    _changed: function(old) {
      var self = this;
      $.each(this._parents, function(_idx, p) {
        p._childChanged(self, old);
      });
    }
  });
  $.extend(QDataNode, {
    make: function(data) {
      if (data instanceof QDataNode) { return data; }
      if (data instanceof Array) { return new QDataList(list); }
      return new QData(data);
    },
  });
  QDataNode.prototype = Object.create(QPubSub);

  function QDeleteThis() {
    if (this === window) {
      return new QDeleteThis();
    }
  }
  function QData(data) {
    QDataNode.call(this);
    this._data = data;
  }
  QData.prototype = $.extend(Object.create(QDataNode), {
    set: function(data) {
      var self = this;
      var old = this._data;
      this._data = $.extend({}, this._data);
      var apply = function(o, d) {
        $.each(d, function(k, v) {
          if (v instanceof QDeleteThis) {
            delete o[k];
          } else if (typeof v !== 'object') {
            o[k] = v;
          } else {
            o[k] = $.extend({}, o[k]);
            apply(o[k], v);
          }
        });
      };
      apply(this._data, data);
      this._notify('change', old);
      this._changed(old);
      return this;
    },
    data: function() {
      return this._data;
    }
  });

  function QDataList(list) {
    QDataNode.call(this);
    var self = this;
    this._data = list || [];
    $.each(this._data, function(_idx, v) {
      v._addParent(self);
    });
  }
  QDataList.prototype = $.extend(Object.create(QDataNode), {
    add: function(elem) {
      this._data.push(elem);
      elem._addParent(this);
      this._notify('add', elem);
      return this;
    },
    remove: function(elem) {
      var prevLength = this._data.length;
      this._data = this._data.filter(function(v) { return v !== elem; });
      if (this._data.length == prevLength) {
        throw new Error("Attempted to remove QDataObject from a collection it wasn't a member of");
      }
      elem._removeParent(this);
      this._notify('remove', elem);
      return this;
    },
    get: function(idx) {
      return this._data[idx];
    },
    _childChanged: function(child, old, source) {
      if (!source) source = 'data';
      this._notify('change.'+source, child, old);
    }
  });

  function QDataDict(data) {
    QDataList.call(this, data || {});
  }
  QDataDict.prototype = $.extend(Object.create(QDataList), {
    add: function(key, elem) {
      if (typeof this._data[key] !== 'undefined') {
        if (this._data[key] === elem) {
          // For now it seems expedient to just ignore this case
          return;
        }
        throw new Error("Attempted to add new key to QDataDict that already existed");
      }
      this._data[key] = elem;
      elem._addParent(this);
      this._notify('add', elem);
      return this;
    },
    removeKey: function(key) {
      if (typeof this._data[key] === 'undefined') {
        throw new Error("Attempted to remove key from QDataDict that didn't actually exist");
      }
      var elem = this._data[key];
      delete this._data[key];
      elem._removeParent(this);
      this._notify('remove', elem);
      return this;
    },
    _childChanged: function(child, old) {
      this._notify('change', child, old);
    }
  });
  // }}}

  /*
   * qtransformer: create a clone of a qdata object, providing customizable,
   * bidirectional propagation of changes.
   *
   * Suppose you have data from your server that describes a set of products.
   * You want to render them using a generic picture-plus-title widget which
   * expects a different data format than the one your product records use.
   *
   * You can solve this by creating a QTransformer that transforms each
   * product record into a format supported by the widget. The transform will
   * automatically update whenever the product record changes.
   *
   * Transforms can have arbitrary complexity. You could create a transformed
   * copy of a product record that doesn't actually transform anything, then
   * feed the copy into a product editor widget. The transform from original
   * to editor's copy could, on updates to the original record, merge the
   * updates into the editor in a way suitable for the application, possibly
   * presenting the user with conflict resolution options. Finally, when the
   * editor has been dismissed and the database updated, the transform back to
   * the original could simply copy the editor's data.
   */
  function QTransformer(opts) {
    QDataNode.call(this);
    var self = this;
    this._data = {};
    this._base = opts.base;
    this._morph = opts.morph;
    this._unmorph = opts.unmorph;
    this._base.on('change', function(_self, old) {
      self.morph();
    });
    this._data.on('change', function(_self, old) {
      self.unmorph();
    });
  }
  $.extend(QTransformer.prototype, Object.create(QDataNode), {
    _morphLevel: function(data, xform) {
      
    },
    morph: function() {
      
    },
    _unmorphLevel: function(data, xform) {
      
    },
    unmorph: function() {
      
    }
  });

  /*
   * qwidget: automatically apply qdata changes to DOM
   *
   * An instance of QWidget has a QData object and a DOM element associated
   * with it and automatically re-renders the DOM element whenever the QData
   * changes.
   *
   * The instance additionally binds any DOM event handlers needed for
   * user interaction.
   */
  function QWidget(opts) {
    QPubSub.call(this);

    var self = this;
    this._data = opts.data;
    this._dirty = false;

    var $tmpl = $(opts.template);
    this.$e = $tmpl.clone();
    this.render();

    this._changeHandler = function(_d, old) {
      if (self.isDirty()) {
        // TODO pass to conflict resolution
      }
      self.render();
    };
    data.on('change', this._changeHandler);
  }
  $.extend(QWidget.prototype, Object.create(QPubSub), {
    isDirty: function() {
      return this._dirty;
    },
    render: function() {
      this.$e.qbind(this);
      return this;
    },
    element: function() {
      return this.$e;
    },
    detach: function() {
      this.off('change', this._changeHandler);
    },
    remove: function() {
      this.detach();
      this.$e.remove();
    }
  });

  function QWidgetGroup(opts) {
    QPubSub.call(this);
    var self = this;
    this.$c = $(opts.container);
    this._data = opts.data;
    this._childrenMap = {};
    this._children = [];
    this._idField = opts.idField || 'id';

    if (opts.generate) {
      this._generate = opts.generate;
    } else {
      this._generate = function() {
        return {
          type: opts.type,
          template: opts.template
        };
      };
      this._type = opts.type;
      var $tmpl = $(opts.template);
      if (!$tmpl || $tmpl.length === 0) {
        throw new Error("Couldn't find widget template for QWidgetFactory");
      }
      this.$tmpl = $tmpl;
    }
    if (opts.comparator) {
      this._comparator = opts.comparator;
    } else {
      this._comparator = function(a, b) {
        return a[this._idField].localeCompare(b[this._idField]);
      };
    }

    this._addHandler = function(_d, newChild) {
      var gen = self._generate(newChild);
      var type = gen.type;
      delete gen.type;
      gen.data = _d;
      /* jshint newcap: false */
      var qw = new type(gen);
      /* jshint newcap: true */
      self._childrenMap[newChild[self._idField]] = qw;
      var idx = this._insertWidget(qw);
      self._insertElem(qw.element(), idx);
    };
    this._data.on('add', this._addHandler);
    this._removeHandler = function(_d, chld) {
      var qw = self._children[chld[self._idField]];
      if (!qw) {
        throw new Error("Tried to remove non-existent widget from QWidgetFactory");
      }
      qw.remove();
      delete self._children[chld[self._idField]];
      self._removeWidget(qw);
    };
    this._data.on('remove', this._removeHandler);
  }
  $.extend(QWidgetFactory.prototype, Object.create(QPubSub), {
    detach: function() {
      this.off('add', this._addHandler);
      this.off('remove', this._removeHandler);
    },
    remove: function() {
      this.$c.remove();
    },
    resort: function() {
      var list = this._children;
      this._children = [];
      this.$c.children().detach();
      $.each(list, function(_idx, v) {
        var idx = this._insertWidget(v);
        this._insertElem(qw.element(), idx);
      });
    },
    comparator: function(cmp) {
      if (!cmp) { return this._comparator; }
      if (this._comparator === cmp) { return; }
      this._comparator = cmp;
      this.resort();
    },
    _insertWidget: function(qw, l, r) {
      if (typeof l === 'undefined') {
        l = -1;
        r = this._children.length;
      }
      if (r-l === 1) {
        if (r === 0 || r === this._children.length) {
          this._children.push(qw);
          return 0;
        }
        this._children.splice(r, 0, qw);
        return r;
      }
      // Binary search
      var pivot = Math.round((l+r)/2); // r-l >= 2, therefore int(pivot) is between l and r
      var cmp = this._comparator(qw, this._children[pivot]);
      if (cmp === 0) {
        this._children.splice(pivot, 0, qw);
        return pivot;
      }
      if (cmp < 0) {
        return this._insertWidget(qw, l, pivot);
      }
      return this._insertWidget(qw, pivot, r);
    },
    _insertElem: function(elem, idx) {
      if (this.$c.length === idx) {
        this.$c.append(elem);
        return;
      }
      elem.insertBefore(this.$c.children().eq(idx));
    },
    _removeWidget: function(qw) {
      this._children = this._children.filter(function(e) { return e !== qw; });
    }
  });

}(jQuery, window._, window.document, window));
