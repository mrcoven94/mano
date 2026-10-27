declare module "heic-decode" {
  export interface HeicImage {
    width: number;
    height: number;
    data: Uint8Array;
  }
  export function decode(bytes: Uint8Array): Promise<HeicImage>;
  const lib: { decode: typeof decode };
  export default lib;
}
