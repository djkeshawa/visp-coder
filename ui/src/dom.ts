/**
 * The page never assigns HTML strings. Every piece of recorded text — check
 * output, review prose, the agent's words — reaches the DOM as a text node, so
 * nothing an agent wrote can become markup.
 */

type Child = Node | string | number | false | null | undefined | readonly Child[];
type Attributes = Record<string, string | number | boolean | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (attributes) applyAttributes(element, attributes);
  append(element, children);
  return element;
}

function applyAttributes(element: HTMLElement, attributes: Attributes): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(name.slice(2).toLowerCase(), value);
    else if (name === "class") element.className = String(value);
    else if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, String(value));
  }
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

const SVG = "http://www.w3.org/2000/svg";

/** Icons are drawn from a fixed set of path data; none come from recorded state. */
const ICONS: Record<string, string> = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  cross: "M6 6l12 12M18 6L6 18",
  dot: "M12 12h.01",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  alert:
    "M12 8v5M12 16.5h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  question: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  copy: "M8 8h11v11H8zM5 16H4V5h11v1",
  close: "M6 6l12 12M18 6L6 18",
  sun: "M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4L7 17M17 7l1.4-1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  auto: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z",
  inbox: "M4 13h4l2 3h4l2-3h4M5 5h14l1 8v6H4v-6z",
  review: "M4 5h16v11H9l-5 4zM8 9h8M8 12h5",
  play: "M8 5v14l11-7z",
  flag: "M5 21V4h11l-1.5 4L16 12H5",
  pause: "M9 5v14M15 5v14",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  wrap: "M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m0 0l2-2m-2 2l2 2M4 18h5",
  down: "M12 5v14m0 0l-6-6m6 6l6-6",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  keyboard: "M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
};

export function icon(name: keyof typeof ICONS | string, label?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `icon icon-${name}`);
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name] ?? ICONS.dot ?? "");
  svg.appendChild(path);
  if (name === "auto") {
    // Follow-the-system: a circle, half dark and half light.
    const half = document.createElementNS(SVG, "path");
    half.setAttribute("d", "M12 3a9 9 0 0 1 0 18z");
    half.setAttribute("fill", "currentColor");
    svg.appendChild(half);
  }
  return svg;
}
