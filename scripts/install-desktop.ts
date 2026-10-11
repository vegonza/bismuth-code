// bun scripts/install-desktop.ts — adds bismuth to the app launcher (XDG .desktop entry + hicolor icon) for this checkout.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const apps = join(data, "applications");
const hicolor = join(data, "icons", "hicolor");
mkdirSync(apps, { recursive: true });
mkdirSync(join(hicolor, "scalable", "apps"), { recursive: true });

await Bun.write(join(hicolor, "scalable", "apps", "bismuth.svg"), Bun.file(join(root, "assets", "icon.svg")));
// PNG sizes too, for launchers and switchers that don't render SVG icons.
for (const px of [32, 64, 128, 256, 512]) {
  mkdirSync(join(hicolor, `${px}x${px}`, "apps"), { recursive: true });
  await Bun.write(join(hicolor, `${px}x${px}`, "apps", "bismuth.png"), Bun.file(join(root, "assets", px === 512 ? "icon.png" : `icon-${px}.png`)));
}
await Bun.write(
  join(apps, "bismuth.desktop"),
  `[Desktop Entry]
Type=Application
Name=bismuth
Comment=Desktop UI for Codex, Claude Code and Cursor agents
Exec=${join(root, "node_modules", "electron", "dist", "electron")} ${root} %f
Icon=bismuth
Terminal=false
Categories=Development;
StartupWMClass=bismuth
`,
);
console.log(`installed ${join(apps, "bismuth.desktop")}`);
