import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("expo-file-system/legacy", () => ({ deleteAsync: vi.fn() }));
vi.mock("expo-image-picker", () => ({
  requestMediaLibraryPermissionsAsync: vi.fn(async () => ({ granted: false })),
  requestCameraPermissionsAsync: vi.fn(async () => ({ granted: false })),
  launchImageLibraryAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
  MediaTypeOptions: { Images: "images", Videos: "videos" },
  VideoExportPreset: { H264_1280x720: 1 },
}));

import * as ImagePicker from "expo-image-picker";
import { pickMailPhotos, pickMailVideo, takeMailPhoto, takeMailVideo } from "../lib/media";
import { PermissionDeniedError, mediaNoteText, noteFor } from "../lib/permission-note";
import { en, es } from "../lib/strings";

describe("a denied permission", () => {
  it("names which one the picker was refused, and opens no picker", async () => {
    await expect(pickMailPhotos().catch(noteFor)).resolves.toBe("library");
    await expect(pickMailVideo().catch(noteFor)).resolves.toBe("library");
    await expect(takeMailPhoto().catch(noteFor)).resolves.toBe("camera");
    await expect(takeMailVideo().catch(noteFor)).resolves.toBe("camera");
    expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it("calls anything else a failure, not a permission", () => {
    expect(noteFor(new Error("unreadable"))).toBe("failed");
    expect(noteFor(new PermissionDeniedError("microphone"))).toBe("microphone");
  });

  it("says what happened and how to turn it on, in both languages", () => {
    for (const strings of [en, es]) {
      const phone = mediaNoteText("camera", "ios", strings);
      expect(phone.text).toBe(`${strings.permissionCamera} ${strings.permissionHowPhone}`);
      expect(phone.opensSettings).toBe(true);
      const web = mediaNoteText("microphone", "web", strings);
      expect(web.text).toBe(`${strings.permissionMicrophone} ${strings.permissionHowWeb}`);
      expect(web.opensSettings).toBe(false);
      expect(mediaNoteText("library", "android", strings).text).toContain(strings.permissionLibrary);
      expect(mediaNoteText("failed", "ios", strings)).toEqual({ text: strings.mediaFailed, opensSettings: false });
    }
  });
});
