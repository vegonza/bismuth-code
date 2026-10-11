// bun scripts/icon.ts — renders assets/icon.svg (the logo, the source of truth) to the PNG sizes via rsvg-convert.
const dir = new URL("../assets/", import.meta.url).pathname;
for (const px of [512, 256, 128, 64, 32]) {
  const out = px === 512 ? "icon.png" : `icon-${px}.png`;
  await Bun.$`rsvg-convert -w ${px} -h ${px} ${dir}icon.svg -o ${dir}${out}`;
}
console.log("rendered", dir + "icon.svg");
