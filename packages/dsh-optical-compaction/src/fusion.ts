import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

const FUSION_FAMILY = "DshOpticalFusionPixel12";
const FUSION_FONT_PATH = fileURLToPath(new URL("./assets/fusion-pixel-12px-zh-hans.ttf", import.meta.url));

let fusionRegistered = false;

function ensureFusionFont(): void {
	if (fusionRegistered) return;
	if (GlobalFonts.registerFromPath(FUSION_FONT_PATH, FUSION_FAMILY) === null) {
		throw new Error(`dsh-optical-compaction: could not register Fusion Pixel font at ${FUSION_FONT_PATH}`);
	}
	fusionRegistered = true;
}

export interface FusionGlyphPlacement {
	char: string;
	column: number;
	row: number;
	units: number;
	dim: boolean;
}

export interface FusionOverlayOptions {
	cellWidth: number;
	cellHeight: number;
	lineRepeat: number;
	glyphs: readonly FusionGlyphPlacement[];
}

/**
 * Replace only the wide glyph cells in an OMP bitmap frame with Fusion Pixel.
 * The Latin bitmap underneath remains byte-for-byte unchanged. Skia is also
 * what Chromium used for the K3 OCR comparison, so this follows the evaluated
 * glyph metrics and integer placement exactly without a browser dependency.
 */
export async function overlayFusionWideGlyphs(
	base64Png: string,
	options: FusionOverlayOptions,
): Promise<string> {
	if (options.glyphs.length === 0) return base64Png;
	ensureFusionFont();

	const image = await loadImage(Buffer.from(base64Png, "base64"));
	const canvas = createCanvas(image.width, image.height);
	const context = canvas.getContext("2d");
	context.imageSmoothingEnabled = false;
	context.drawImage(image, 0, 0);

	for (const glyph of options.glyphs) {
		const x = glyph.column * options.cellWidth;
		const boxWidth = glyph.units * options.cellWidth;
		for (let copy = 0; copy < options.lineRepeat; copy++) {
			const y = (glyph.row * options.lineRepeat + copy) * options.cellHeight;
			context.fillStyle = "#fff";
			context.fillRect(x, y, boxWidth, options.cellHeight);
			context.fillStyle = glyph.dim ? "#808080" : "#000";
			context.font = `${options.cellHeight}px ${FUSION_FAMILY}`;
			context.textBaseline = "alphabetic";
			const metrics = context.measureText(glyph.char);
			const glyphWidth = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
			const glyphHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
			const left = x + (boxWidth - glyphWidth) / 2 + metrics.actualBoundingBoxLeft;
			const baseline = y + (options.cellHeight - glyphHeight) / 2 + metrics.actualBoundingBoxAscent;
			context.fillText(glyph.char, Math.round(left), Math.round(baseline));
		}
	}

	return (await canvas.encode("png")).toString("base64");
}
