// Picking mail photos and video through Expo's image picker. Library
// picks return base64 inline; anything larger (video) is read through
// the file system. Screens call these; the queue and client only see
// bytes, so tests never touch Expo modules.

import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { b64encode } from "./base64";

export interface PickedMedia {
  kind: "photo" | "video";
  name: string;
  mimeType: string;
  bytesB64: string;
  localUri: string;
}

function mediaName(asset: { fileName?: string | null; uri: string }, kind: "photo" | "video", index: number): string {
  if (asset.fileName) return asset.fileName;
  const ext = kind === "photo" ? "jpg" : "mp4";
  return `mail-${Date.now()}-${index}.${ext}`;
}

export async function fileToB64(uri: string): Promise<string> {
  const buf = await new File(uri).arrayBuffer();
  return b64encode(new Uint8Array(buf));
}

async function toPicked(
  asset: { uri: string; fileName?: string | null; mimeType?: string; base64?: string | null },
  kind: "photo" | "video",
  index: number,
): Promise<PickedMedia> {
  return {
    kind,
    name: mediaName(asset, kind, index),
    mimeType: asset.mimeType ?? (kind === "photo" ? "image/jpeg" : "video/mp4"),
    bytesB64: asset.base64 ?? (await fileToB64(asset.uri)),
    localUri: asset.uri,
  };
}

// Several photos in one go, compressed for a slow connection.
export async function pickMailPhotos(): Promise<PickedMedia[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error("Photo permission was not granted.");
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsMultipleSelection: true,
    base64: true,
    quality: 0.7,
  });
  if (result.canceled) return [];
  return Promise.all(result.assets.map((a, i) => toPicked(a, "photo", i)));
}

export async function takeMailPhoto(): Promise<PickedMedia | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error("Camera permission was not granted.");
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    base64: true,
    quality: 0.7,
  });
  if (result.canceled || !result.assets[0]) return null;
  return toPicked(result.assets[0], "photo", 0);
}

export async function pickMailVideo(): Promise<PickedMedia | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error("Photo permission was not granted.");
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Videos,
    allowsMultipleSelection: false,
    videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720,
  });
  if (result.canceled || !result.assets[0]) return null;
  return toPicked(result.assets[0], "video", 0);
}

export async function takeMailVideo(): Promise<PickedMedia | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error("Camera permission was not granted.");
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Videos,
    videoMaxDuration: 60,
    videoExportPreset: ImagePicker.VideoExportPreset.H264_1280x720,
  });
  if (result.canceled || !result.assets[0]) return null;
  return toPicked(result.assets[0], "video", 0);
}
