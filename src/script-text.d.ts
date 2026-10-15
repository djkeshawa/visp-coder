/** Files named *.script.mjs are bundled as text (a tsup plugin, Vite ?raw) and written out by the installer. */
declare module "*.script.mjs?raw" {
  const text: string;
  export default text;
}
