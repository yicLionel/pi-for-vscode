/**
 * Pikachu header for the Pi TUI.
 *
 * Replaces the built-in startup banner with pixel art, in the spirit of
 * OpenClaw's homepage hero. The sprite is a 36x28 pixel grid rendered with
 * half-block characters, so every character cell carries two vertical pixels.
 * Uses 24-bit colour when the terminal supports it and falls back to the
 * xterm-256 cube otherwise.
 *
 * Install: ~/.pi/agent/extensions/pikachu-header.ts  (then `/reload`)
 * Toggle:  /pikachu
 */
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

type Rgb = readonly [number, number, number];
type ColorMode = "truecolor" | "256color";

const SPRITE_WIDTH = 36;

/** One character per pixel. '.' is transparent. */
const SPRITE: readonly string[] = [
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
];

const PALETTE: Record<string, Rgb> = {
  o: [0x2b, 0x21, 0x18], // outline
  y: [0xf7, 0xd0, 0x2c], // body
  k: [0x1c, 0x1c, 0x1c], // ear tips, eyes
  w: [0xff, 0xff, 0xff], // eye highlight
  r: [0xe3, 0x35, 0x0d], // cheeks
  b: [0x8b, 0x5a, 0x2b], // back stripes
};

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

/** Emits one run of identical (top, bottom) pixel pairs. */
function paintRun(topChar: string, bottomChar: string, count: number, mode: ColorMode): string {
  const top = PALETTE[topChar];
  const bottom = PALETTE[bottomChar];

  if (!top && !bottom) return "\x1b[39m\x1b[49m" + " ".repeat(count);
  if (top && !bottom) return fgAnsi(top, mode) + "\u2580".repeat(count) + RESET;
  if (!top && bottom) return fgAnsi(bottom, mode) + "\u2584".repeat(count) + RESET;
  // Both halves the same colour: paint a space with a background. A background
  // fills the cell exactly, whereas block glyphs can leave hairline seams.
  if (top === bottom) return bgAnsi(top, mode) + " ".repeat(count) + RESET;
  return fgAnsi(top, mode) + bgAnsi(bottom, mode) + "\u2580".repeat(count) + RESET;
}

function renderSprite(theme: Theme, width: number): string[] | undefined {
  if (width < SPRITE_WIDTH) return undefined;
  const mode = theme.getColorMode();
  const indent = " ".repeat(Math.max(0, Math.floor((width - SPRITE_WIDTH) / 2)));
  const lines: string[] = [];

  for (let row = 0; row < SPRITE.length; row += 2) {
    const top = SPRITE[row] ?? "";
    const bottom = SPRITE[row + 1] ?? "";
    let line = indent;
    let col = 0;
    while (col < SPRITE_WIDTH) {
      const topChar = top[col] ?? ".";
      const bottomChar = bottom[col] ?? ".";
      let end = col + 1;
      while (end < SPRITE_WIDTH && (top[end] ?? ".") === topChar && (bottom[end] ?? ".") === bottomChar) end++;
      line += paintRun(topChar, bottomChar, end - col, mode);
      col = end;
    }
    lines.push(line + RESET);
  }

  return lines;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleWidth = (text: string): number => text.replace(ANSI, "").length;

function center(text: string, width: number): string {
  return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) + text;
}

export default function (pi: ExtensionAPI) {
  let enabled = true;

  const apply = (ctx: { mode: string; ui: { setHeader: (f: unknown) => void } }) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui: unknown, theme: Theme) => ({
      render(width: number): string[] {
        const art = renderSprite(theme, width);
        const lines: string[] = [""];

        if (art) {
          lines.push(...art);
        } else {
          lines.push("");
          lines.push(center(theme.fg("muted", "pi"), width));
        }

        lines.push("");
        lines.push(center(theme.fg("accent", `pi v${VERSION}`), width));
        lines.push(center(theme.fg("dim", "escape interrupt  ·  / commands  ·  ! bash  ·  ctrl+o more"), width));
        lines.push("");
        return lines;
      },
      invalidate() {},
    }));
  };

  pi.on("session_start", async (_event, ctx) => {
    if (enabled) apply(ctx);
  });

  pi.registerCommand("pikachu", {
    description: "Toggle the Pikachu startup header",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) apply(ctx);
      else ctx.ui.setHeader(undefined);
      ctx.ui.notify(enabled ? "Pikachu header enabled" : "Built-in header restored", "info");
    },
  });
}
