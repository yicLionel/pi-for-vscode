/**
 * Header art for the Pi TUI.
 *
 * Replaces the built-in startup banner with either pixel art or a real image,
 * in the spirit of OpenClaw's homepage hero.
 *
 * Two kinds of art:
 *
 * - `pixel`  a pixel grid rendered with half-block characters, so one character
 *            cell carries two vertical pixels and the proportions survive a
 *            terminal cell that is twice as tall as it is wide. 24-bit colour
 *            with an xterm-256 cube fallback. Ships with one: `pikachu`.
 * - `image`  a real image file rendered through the terminal's inline image
 *            protocol (no pixelation). These come from a personal directory,
 *            so they never need to live in a git repository:
 *
 *              ~/.pi/agent/header-art/<name>.{png,jpg,jpeg,gif,webp}
 *
 * Use `/header` to cycle, `/header <name>` to pick, `/header list` to see what
 * is available. The choice is remembered in ~/.pi/agent/header-art.json.
 *
 * Inline images need terminal support. Inside the VS Code sidebar the extension
 * sets PI_IMAGE_PROTOCOL=iterm2 and the webview loads @xterm/addon-image; in a
 * terminal, kitty/iTerm2 are auto-detected. Without support the image degrades
 * to a text line naming the file.
 *
 * Install: ~/.pi/agent/extensions/header-art.ts  (then `/reload`)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCapabilities,
  getImageDimensions,
  imageFallback,
  renderImage,
} from "@earendil-works/pi-tui";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

type Rgb = readonly [number, number, number];
type ColorMode = "truecolor" | "256color";

interface PixelArt {
  name: string;
  kind: "pixel";
  /** One character per pixel. Every character must exist in `palette`. */
  palette: Record<string, Rgb>;
  grid: readonly string[];
}

interface ImageArt {
  name: string;
  kind: "image";
  file: string;
  mimeType: string;
  /** Preferred width in terminal cells. */
  maxWidthCells: number;
}

type Art = PixelArt | ImageArt;

const IMAGE_DIR = path.join(os.homedir(), ".pi", "agent", "header-art");
const STATE_FILE = path.join(os.homedir(), ".pi", "agent", "header-art.json");
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// --- Art: pikachu (36x28) --------------------------------------------------
const PIKACHU: PixelArt = {
  name: "pikachu",
  kind: "pixel",
  palette: {
    o: [0x2b, 0x21, 0x18], // outline
    y: [0xf7, 0xd0, 0x2c], // body
    k: [0x1c, 0x1c, 0x1c], // ear tips, eyes
    w: [0xff, 0xff, 0xff], // eye highlight
    r: [0xe3, 0x35, 0x0d], // cheeks
    b: [0x8b, 0x5a, 0x2b], // back stripes
  },
  grid: [
    "....................................",
    "........oooo.............oooo.......",
    ".......okkkko...........okkkko......",
    "........okkko...........okkko.......",
    ".........okko...........okko........",
    "..........oko...........oko.........",
    "..........oyo.....o.....oyo.........",
    "...........oo.ooooyoooo.oo..........",
    "...........oyoyyyyyyyyyoyo..........",
    "...........oyyyyyyyyyyyyyo..........",
    "...........oyyyyyyyyyyyyyo..........",
    "..........oyyyyyyyyyyyyyyyo.........",
    ".........oyyyywkyyyyykwyyyyo........",
    ".........oyyykwkkyyykwkkyyyo...o....",
    ".........oyyykkkkyyykkkkyyyo..oyo...",
    ".........oyyyykkyyyyykkyyyyo..oyo...",
    ".........oyrrrrykykykyrrrryo.oyyo...",
    "..........orrrryykykyyrrrro..oyyoooo",
    "..........orrrryyyyyyyrrrro.oyyyyyyy",
    "...........ooyyyyyyyyyyyoo...oyyyyyo",
    "...........obbyyyyyyyyybbo...oyyyyo.",
    "...........obbyyyyyyyyybbo...oyyyo..",
    "...........obbyyyyyyyyybbo...oyyyo..",
    "...........oyyyyyyyyyyyyyo...oyyo...",
    "............oyyyyyyyyyyyo....oyo....",
    "...........oyyyyyyyyyyyyyo....o.....",
    "............oyyyyoyoyyyyo...........",
    ".............oooo.o.oooo............",
  ],
};

// --- personal images -------------------------------------------------------

/** Everything in ~/.pi/agent/header-art, so personal images stay out of git. */
function loadImageArts(): ImageArt[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(IMAGE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, file: path.join(IMAGE_DIR, entry.name) }))
    .map(({ name, file }) => ({ name, file, mimeType: MIME_TYPES[path.extname(file).toLowerCase()] }))
    .filter((entry): entry is { name: string; file: string; mimeType: string } => Boolean(entry.mimeType))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, file, mimeType }) => ({
      name: path.basename(name, path.extname(name)),
      kind: "image" as const,
      file,
      mimeType,
      maxWidthCells: 46,
    }));
}

function allArts(): Art[] {
  return [PIKACHU, ...loadImageArts()];
}

// --- text helpers ----------------------------------------------------------

/**
 * Header text tiers, longest first. ASCII only, so a string's visible width is
 * exactly its length and clipping is a plain slice.
 *
 * pi treats a custom header line wider than the terminal as fatal:
 *   "Rendered line N exceeds terminal width", then it exits.
 * So every returned line must fit the width we are handed.
 */
const HINTS: readonly string[] = [
  "escape interrupt - / commands - ! bash - ctrl+o more",
  "esc interrupt - / commands - ctrl+o more",
  "esc - / cmds - ctrl+o more",
  "esc - / cmds - ctrl+o",
];

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];
const RESET = "\x1b[0m";

function rgbTo256(r: number, g: number, b: number): number {
  const axis = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  const [ri, gi, bi] = [axis(r), axis(g), axis(b)];
  const [cr, cg, cb] = [CUBE_STEPS[ri], CUBE_STEPS[gi], CUBE_STEPS[bi]];
  const cubeDist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;

  const grayIndex = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = 8 + grayIndex * 10;
  const grayDist = (r - gray) ** 2 + (g - gray) ** 2 + (b - gray) ** 2;

  return grayDist < cubeDist ? 232 + grayIndex : 16 + 36 * ri + 6 * gi + bi;
}

function fgAnsi(rgb: Rgb, mode: ColorMode): string {
  return mode === "truecolor"
    ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
    : `\x1b[38;5;${rgbTo256(rgb[0], rgb[1], rgb[2])}m`;
}

function bgAnsi(rgb: Rgb, mode: ColorMode): string {
  return mode === "truecolor"
    ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
    : `\x1b[48;5;${rgbTo256(rgb[0], rgb[1], rgb[2])}m`;
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width));
}

/** Pads to centre, clipping first. `style` is applied after measuring. */
function centered(text: string, width: number, style: (value: string) => string): string {
  const clipped = clip(text, width);
  if (!clipped) return "";
  return " ".repeat(Math.max(0, Math.floor((width - clipped.length) / 2))) + style(clipped);
}

// --- pixel rendering -------------------------------------------------------

/** Emits one run of identical (top, bottom) pixel pairs. */
function paintRun(art: PixelArt, topChar: string, bottomChar: string, count: number, mode: ColorMode): string {
  const top = art.palette[topChar];
  const bottom = art.palette[bottomChar];

  if (!top && !bottom) return "\x1b[39m\x1b[49m" + " ".repeat(count);
  if (top && !bottom) return fgAnsi(top, mode) + "\u2580".repeat(count) + RESET;
  if (!top && bottom) return fgAnsi(bottom, mode) + "\u2584".repeat(count) + RESET;
  // Both halves the same colour: paint a space with a background. A background
  // fills the cell exactly, whereas block glyphs can leave hairline seams.
  if (top === bottom) return bgAnsi(top, mode) + " ".repeat(count) + RESET;
  return fgAnsi(top, mode) + bgAnsi(bottom, mode) + "\u2580".repeat(count) + RESET;
}

function renderPixel(art: PixelArt, theme: Theme, width: number): string[] | undefined {
  const spriteWidth = art.grid[0]?.length ?? 0;
  // Leave slack so a terminal that treats block glyphs as double-width cannot
  // push a sprite line over the edge.
  if (spriteWidth === 0 || width < spriteWidth + 2) return undefined;

  const mode = theme.getColorMode();
  const indent = " ".repeat(Math.max(0, Math.floor((width - spriteWidth) / 2)));
  const lines: string[] = [];

  for (let row = 0; row < art.grid.length; row += 2) {
    const top = art.grid[row] ?? "";
    const bottom = art.grid[row + 1] ?? "";
    let line = indent;
    let col = 0;
    while (col < spriteWidth) {
      const topChar = top[col] ?? ".";
      const bottomChar = bottom[col] ?? ".";
      let end = col + 1;
      while (end < spriteWidth && (top[end] ?? ".") === topChar && (bottom[end] ?? ".") === bottomChar) end++;
      line += paintRun(art, topChar, bottomChar, end - col, mode);
      col = end;
    }
    lines.push(line + RESET);
  }

  return lines;
}

// --- image rendering -------------------------------------------------------

/**
 * Renders a real image through the terminal's inline image protocol.
 *
 * Note the whole file is base64'd into the escape sequence, so a multi-megabyte
 * photo would be re-transmitted on every header repaint. Anything over the
 * budget degrades to the text fallback instead.
 */
const IMAGE_BYTE_BUDGET = 1_500_000;

function renderImageArt(art: ImageArt, width: number, theme: Theme): string[] | undefined {
  let bytes: Buffer;
  try {
    const stat = fs.statSync(art.file);
    if (stat.size > IMAGE_BYTE_BUDGET) {
      return fallbackLines(art, width, theme, `${Math.round(stat.size / 1024)}KB, over the ${Math.round(IMAGE_BYTE_BUDGET / 1024)}KB budget`);
    }
    bytes = fs.readFileSync(art.file);
  } catch {
    return fallbackLines(art, width, theme, "unreadable");
  }

  const base64 = bytes.toString("base64");
  const dimensions = getImageDimensions(base64, art.mimeType);
  if (!dimensions) return fallbackLines(art, width, theme, "unsupported image");

  const maxWidthCells = Math.max(8, Math.min(art.maxWidthCells, width - 2));
  const rendered = renderImage(base64, dimensions, { maxWidthCells });
  if (!rendered) return fallbackLines(art, width, theme, "terminal has no inline image support");

  const indent = " ".repeat(Math.max(0, Math.floor((width - rendered.columns) / 2)));
  // The image is painted by the first line; the remaining rows only need to be
  // reserved so the layout below the header lands in the right place.
  const lines = [indent + rendered.sequence];
  for (let row = 1; row < rendered.rows; row++) lines.push(" ".repeat(width));
  return lines;
}

function fallbackLines(art: ImageArt, width: number, theme: Theme, why: string): string[] {
  return [
    "",
    centered(art.name, width, (t) => theme.fg("muted", t)),
    centered(`(${why})`, width, (t) => theme.fg("dim", t)),
  ];
}

// --- remembered choice -----------------------------------------------------

function loadChoice(): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))?.name;
  } catch {
    return undefined;
  }
}

function saveChoice(name: string): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify({ name }, null, 2)}\n`);
  } catch {
    // A header preference is not worth failing a session over.
  }
}

// --- extension ------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let arts = allArts();
  let current = Math.max(0, arts.findIndex((art) => art.name === loadChoice()));

  const apply = (ctx: { mode: string; ui: { setHeader: (f: unknown) => void } }) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui: unknown, theme: Theme) => ({
      render(width: number): string[] {
        const art = arts[current] ?? PIKACHU;
        const rendered =
          art.kind === "pixel" ? renderPixel(art, theme, width) : renderImageArt(art, width, theme);

        const lines: string[] = rendered ? [...rendered] : ["", centered(art.name, width, (t) => theme.fg("muted", t))];

        lines.push("");
        lines.push(centered(`pi v${VERSION}`, width, (t) => theme.fg("accent", t)));

        const hint = HINTS.find((candidate) => candidate.length <= width);
        if (hint) lines.push(centered(hint, width, (t) => theme.fg("dim", t)));

        lines.push("");
        return lines;
      },
      invalidate() {},
    }));
  };

  pi.on("session_start", async (_event, ctx) => {
    apply(ctx);
  });

  pi.registerCommand("header", {
    description: "Switch header art: /header, /header <name>, /header list",
    handler: async (args, ctx) => {
      // Re-scan the personal image directory so newly dropped files show up.
      const previous = arts[current]?.name;
      arts = allArts();
      const restored = arts.findIndex((art) => art.name === previous);
      current = restored >= 0 ? restored : 0;

      const requested = (args ?? "").trim();

      if (requested === "list") {
        const names = arts.map((art, index) => `${art.name}${index === current ? " (current)" : ""}`);
        ctx.ui.notify(`Headers: ${names.join(", ")}`, "info");
        return;
      }

      let next = (current + 1) % arts.length;
      if (requested) {
        const index = arts.findIndex((art) => art.name === requested);
        if (index < 0) {
          ctx.ui.notify(`Unknown header "${requested}". Available: ${arts.map((a) => a.name).join(", ")}`, "warning");
          return;
        }
        next = index;
      }

      current = next;
      saveChoice(arts[next].name);
      apply(ctx);
      ctx.ui.notify(`Header: ${arts[next].name}`, "info");
    },
  });
}
