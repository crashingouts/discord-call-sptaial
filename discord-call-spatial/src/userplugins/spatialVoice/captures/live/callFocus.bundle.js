var SVCallFocus = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // callFocus.ts
  var callFocus_exports = {};
  __export(callFocus_exports, {
    CALL_TILE_ATTRIBUTE: () => CALL_TILE_ATTRIBUTE,
    CHEVRON_PATH: () => CHEVRON_PATH,
    CallFocusController: () => CallFocusController,
    FOCUS_ATTRIBUTE: () => FOCUS_ATTRIBUTE,
    FOCUS_TOGGLE_ATTRIBUTE: () => FOCUS_TOGGLE_ATTRIBUTE,
    FOCUS_TOGGLE_CLASS: () => FOCUS_TOGGLE_CLASS,
    FULLSCREEN_CLASS_MARKER: () => FULLSCREEN_CLASS_MARKER,
    GUILD_NAV_PREFIX: () => GUILD_NAV_PREFIX,
    LABEL_EXPAND: () => LABEL_EXPAND,
    LABEL_RESTORE: () => LABEL_RESTORE,
    createCallFocusEnvironment: () => createCallFocusEnvironment,
    findCallView: () => findCallView,
    hasFullScreenClass: () => hasFullScreenClass,
    isFullScreenControl: () => isFullScreenControl,
    toggleLabel: () => toggleLabel
  });
  var FOCUS_TOGGLE_CLASS = "sv-call-focus-toggle";
  var FOCUS_TOGGLE_ATTRIBUTE = "data-sv-call-focus-toggle";
  var FOCUS_ATTRIBUTE = "data-sv-focused";
  var LABEL_EXPAND = "Fullscreen the call";
  var LABEL_RESTORE = "Show the rest of Discord";
  var CHEVRON_PATH = "M9.5 5.5 16 12l-6.5 6.5";
  var CALL_TILE_ATTRIBUTE = "data-call-tile";
  var GUILD_NAV_PREFIX = "guildsnav";
  var FULLSCREEN_CLASS_MARKER = "fullScreen";
  var SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  var MIN_TILE_GRID_RATIO = 0.3;
  var SURFACE_SEARCH_DEPTH = 12;
  var FULLSCREEN_LABEL = /full\s*-?\s*screen/i;
  function parentOf(element) {
    const parent = element.parentElement;
    return parent;
  }
  function lowestCommonAncestor(elements) {
    const first = elements[0];
    if (!first) return null;
    let candidate = first;
    while (candidate) {
      if (elements.every((element) => candidate.contains(element))) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }
  function hasFullScreenClass(className) {
    return className.split(/\s+/).some((token) => token === FULLSCREEN_CLASS_MARKER || token.startsWith(`${FULLSCREEN_CLASS_MARKER}_`));
  }
  function labelOf(element) {
    return element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "";
  }
  function isFullScreenControl(element) {
    if (element.hasAttribute?.(FOCUS_TOGGLE_ATTRIBUTE)) return false;
    return FULLSCREEN_LABEL.test(labelOf(element));
  }
  function containsGuildNav(surface, guildNavs) {
    return guildNavs.some((nav) => surface === nav || surface.contains(nav));
  }
  function readExpanded(grid) {
    for (let node = grid; node; node = node.parentElement) {
      if (hasFullScreenClass(String(node.className ?? ""))) return true;
    }
    return false;
  }
  function findCallView(env, lookup) {
    const tiles = lookup.tiles.filter((tile) => tile.isConnected !== false);
    if (tiles.length === 0) return null;
    const grid = lowestCommonAncestor(tiles);
    if (!grid || grid === env.doc.body || grid === env.doc.documentElement) return null;
    const viewport = env.viewport();
    const gridRect = env.rectOf(grid);
    if (viewport.width > 0 && gridRect.width < viewport.width * MIN_TILE_GRID_RATIO) return null;
    if (viewport.height > 0 && gridRect.height < viewport.height * MIN_TILE_GRID_RATIO) return null;
    let surface = grid;
    let fullscreen = null;
    for (let depth = 0; surface && depth < SURFACE_SEARCH_DEPTH; depth++, surface = parentOf(surface)) {
      const found = lookup.buttons.find((button) => isFullScreenControl(button) && surface.contains(button));
      if (found) {
        fullscreen = found;
        break;
      }
    }
    if (!surface || !fullscreen) return null;
    if (containsGuildNav(surface, lookup.guildNavs ?? [])) return null;
    const controls = lookup.controls && surface.contains(lookup.controls) ? lookup.controls : null;
    return {
      surface,
      grid,
      controls,
      fullscreen,
      expanded: readExpanded(grid)
    };
  }
  function toggleLabel(expanded) {
    return expanded ? LABEL_RESTORE : LABEL_EXPAND;
  }
  function createCallFocusEnvironment(measure, doc = document) {
    const view = doc.defaultView;
    return {
      doc,
      styleOf: (element) => {
        const style = view ? view.getComputedStyle(element) : element.style;
        return {
          position: style.position,
          pointerEvents: style.pointerEvents,
          zIndex: style.zIndex,
          left: style.left,
          top: style.top
        };
      },
      rectOf: measure,
      viewport: () => ({
        width: view?.innerWidth ?? 0,
        height: view?.innerHeight ?? 0
      })
    };
  }
  var CallFocusController = class {
    env;
    channelId = null;
    view = null;
    expanded = false;
    /** True when this controller's own press is what turned fullscreen on. */
    expandedByUs = false;
    /**
     * Looks still allowed to disagree with the press this module made. Discord
     * re-renders a frame or two after its own control is pressed, and the adapter
     * looks on every mutation, so the first look after a press can still read the
     * state before it. Eight looks keeps the chevron steady through that gap
     * without ever ignoring Discord for long.
     */
    pendingLooks = 0;
    disposed = false;
    button = null;
    buttonHost = null;
    chevron = null;
    /** The call view's own inline position, when this module had to write one. */
    surfacePosition = null;
    onToggleClick = (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      this.toggleFullScreen();
    };
    constructor(environment) {
      this.env = environment;
    }
    get state() {
      const { button } = this;
      return {
        channelId: this.channelId,
        expanded: this.expanded,
        mounted: button !== null && button.parentElement !== null,
        label: button?.getAttribute("aria-label") ?? "",
        focused: button?.getAttribute(FOCUS_ATTRIBUTE) ?? null
      };
    }
    /** Looks at the client again. Safe to call on every frame. */
    sync(input) {
      if (this.disposed) return this.state;
      const { channelId, view } = input;
      if (channelId !== this.channelId) {
        this.channelId = channelId;
        this.expandedByUs = false;
        this.pendingLooks = 0;
      }
      const previous = this.view;
      if (!view) {
        const control = previous?.fullscreen;
        if (this.expandedByUs && this.expanded && control?.isConnected !== false) {
          control?.click?.();
        }
        this.view = null;
        this.expanded = false;
        this.expandedByUs = false;
        this.pendingLooks = 0;
        this.removeButton();
        this.restoreSurfacePosition();
        return this.state;
      }
      this.view = view;
      if (view.expanded === this.expanded) {
        this.pendingLooks = 0;
        this.expandedByUs = this.expandedByUs && view.expanded;
      } else if (this.pendingLooks > 0) {
        this.pendingLooks--;
      } else {
        this.expanded = view.expanded;
        this.expandedByUs = this.expandedByUs && view.expanded;
      }
      this.mountButton(view);
      this.paintButton();
      return this.state;
    }
    /** Turns the call fullscreen on, through Discord's own control. */
    expand() {
      if (!this.expanded) this.toggleFullScreen();
    }
    /** Returns Discord's normal view, through Discord's own control. */
    collapse() {
      if (this.expanded) this.toggleFullScreen();
    }
    /** What the chevron does. */
    toggleFullScreen() {
      if (this.disposed) return;
      const control = this.view?.fullscreen;
      if (!control) return;
      control.click?.();
      this.expanded = !this.expanded;
      this.expandedByUs = this.expanded;
      this.pendingLooks = 8;
      this.paintButton();
    }
    /**
     * Takes the chevron away without touching Discord's view: used while the
     * scene's own switch is off. A later look mounts it again.
     */
    suspend() {
      if (this.disposed) return;
      this.removeButton();
      this.restoreSurfacePosition();
    }
    /**
     * Stops working and leaves Discord as a person would expect: the chevron is
     * removed, and a fullscreen this module turned on is turned off again.
     * A fullscreen the user turned on with Discord's own control is theirs and
     * is left alone.
     */
    destroy() {
      if (this.disposed) return;
      this.disposed = true;
      if (this.expandedByUs && this.expanded) {
        const control = this.view?.fullscreen;
        if (control?.isConnected !== false) control?.click?.();
      }
      this.removeButton();
      this.restoreSurfacePosition();
      this.expandedByUs = false;
      this.expanded = false;
      this.pendingLooks = 0;
      this.view = null;
      this.channelId = null;
    }
    /* ---------------------------------------------------------------- internals */
    mountButton(view) {
      const host = view.surface;
      if (!this.button) this.createButton();
      const button = this.button;
      if (this.buttonHost !== host || button.parentElement !== host) {
        button.remove?.();
        host.appendChild(button);
        this.buttonHost = host;
        this.positionButton(button);
      }
      this.claimSurfacePosition(host);
    }
    claimSurfacePosition(surface) {
      if (this.surfacePosition?.element === surface) return;
      this.restoreSurfacePosition();
      const style = this.env.styleOf(surface);
      if (style.position && style.position !== "static") return;
      this.surfacePosition = { element: surface, had: surface.style.position !== "", value: surface.style.position };
      surface.style.position = "relative";
    }
    restoreSurfacePosition() {
      const held = this.surfacePosition;
      if (!held) return;
      held.element.style.position = held.had ? held.value : "";
      this.surfacePosition = null;
    }
    createButton() {
      const { doc } = this.env;
      const button = doc.createElement("button");
      button.type = "button";
      button.className = FOCUS_TOGGLE_CLASS;
      button.setAttribute(FOCUS_TOGGLE_ATTRIBUTE, "");
      const svg = doc.createElementNS(SVG_NAMESPACE, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", "16");
      svg.setAttribute("height", "16");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      const path = doc.createElementNS(SVG_NAMESPACE, "path");
      path.setAttribute("d", CHEVRON_PATH);
      svg.appendChild(path);
      button.appendChild(svg);
      button.addEventListener("click", this.onToggleClick);
      this.button = button;
      this.chevron = path;
    }
    /**
     * Placement the button needs to work with no stylesheet at all. Anything the
     * stylesheet does set is left alone, so the visual layer keeps control of
     * where the button looks like it sits.
     */
    positionButton(button) {
      const style = this.env.styleOf(button);
      if (!style.position || style.position === "static") button.style.position = "absolute";
      if (!style.zIndex || style.zIndex === "auto") button.style.zIndex = "30";
      if (style.pointerEvents === "none") button.style.pointerEvents = "auto";
      if (!style.left || style.left === "auto") button.style.left = "12px";
      if (!style.top || style.top === "auto") button.style.top = "12px";
    }
    paintButton() {
      const { button } = this;
      if (!button) return;
      const { expanded } = this;
      const label = toggleLabel(expanded);
      button.setAttribute(FOCUS_ATTRIBUTE, expanded ? "true" : "false");
      button.setAttribute("aria-pressed", expanded ? "true" : "false");
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      if (this.chevron) this.chevron.setAttribute("d", CHEVRON_PATH);
    }
    removeButton() {
      const { button } = this;
      if (!button) return;
      button.removeEventListener("click", this.onToggleClick);
      button.remove?.();
      this.button = null;
      this.buttonHost = null;
      this.chevron = null;
    }
  };
  return __toCommonJS(callFocus_exports);
})();
