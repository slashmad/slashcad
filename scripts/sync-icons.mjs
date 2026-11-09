// Copies the approved icon set (build/SlashCAD-transparent-icons, the user's artwork) to the
// places the build and the app read from:
//   build/icon.png                    1024 px master (macOS, fallback)
//   build/icons/<n>x<n>.png           Linux icon set (electron-builder `linux.icon`)
//   build/icon.ico                    Windows (16–256 px)
//   src/renderer/public/icon-*.png    window icon, top-bar mark, welcome screen
//   npm run icon
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "build", "SlashCAD-transparent-icons");
const hicolor = join(src, "hicolor");
if (!existsSync(hicolor)) throw new Error(`icon set not found: ${src}`);

const icons = join(root, "build", "icons");
rmSync(icons, { recursive: true, force: true });
mkdirSync(icons, { recursive: true });
for (const size of readdirSync(hicolor)) {
  const png = join(hicolor, size, "apps", "slashcad.png");
  if (/^\d+x\d+$/.test(size) && existsSync(png)) copyFileSync(png, join(icons, `${size}.png`));
}
copyFileSync(join(src, "slashcad-transparent-1024.png"), join(root, "build", "icon.png"));
copyFileSync(join(src, "slashcad.ico"), join(root, "build", "icon.ico"));
const pub = join(root, "src", "renderer", "public");
mkdirSync(pub, { recursive: true });
for (const n of [64, 256]) copyFileSync(join(hicolor, `${n}x${n}`, "apps", "slashcad.png"), join(pub, `icon-${n}.png`));
console.log("icons synced from", src);
