// heic-decode v2 ships no types. This matches its documented API: the
// default export is a function called as decode({ buffer }) returning
// RGBA pixels, with .all for multi-image files.
declare module "heic-decode" {
  export interface HeicImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  export interface HeicImageEntry {
    decode(): Promise<HeicImage>;
  }
  interface DecodeFn {
    (input: { buffer: Uint8Array }): Promise<HeicImage>;
    all(input: { buffer: Uint8Array }): Promise<HeicImageEntry[]>;
  }
  const decode: DecodeFn;
  export default decode;
}
