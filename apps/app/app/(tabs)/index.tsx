// One conversation with the person's agent: text, mail photos and video,
// and voice notes. Offline messages wait in the outbox and send in order
// when the engine is reachable again.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type AppStateStatus,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { RecordingPresets, createAudioPlayer, requestRecordingPermissionsAsync, useAudioRecorder, type AudioPlayer } from "expo-audio";
import { deleteAsync } from "expo-file-system/legacy";
import { SafeAreaView } from "react-native-safe-area-context";
import { Btn, DemoBanner, EmptyView, LoadingView, Title } from "../../components/ui";
import type { Attachment, ChatMessage, NewAttachment } from "../../lib/api/types";
import { AuthError } from "../../lib/api/types";
import { useAuth } from "../../lib/auth";
import { trackCacheFile } from "../../lib/cache-files";
import { useStrings } from "../../lib/i18n";
import { submitMessage } from "../../lib/send";
import { fileToB64, pickMailPhotos, pickMailVideo, takeMailPhoto, takeMailVideo, type PickedMedia } from "../../lib/media";
import type { QueuedMessage } from "../../lib/queue";
import { colors, radius, tapTarget, type } from "../../lib/theme";

function attachmentIcon(kind: Attachment["kind"]): "image-outline" | "videocam-outline" | "mic-outline" | "document-outline" {
  if (kind === "photo") return "image-outline";
  if (kind === "video") return "videocam-outline";
  if (kind === "voice") return "mic-outline";
  return "document-outline";
}

function Bubble({ message, queuedLabel }: { message: ChatMessage; queuedLabel: string }) {
  const mine = message.role === "user";
  return (
    <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        {message.text ? <Text style={[type.body, mine ? styles.textMine : styles.textTheirs]}>{message.text}</Text> : null}
        {message.attachments.map((a) => (
          <View key={a.id} style={styles.attChip}>
            <Ionicons name={attachmentIcon(a.kind)} size={16} color={mine ? colors.ink : colors.text} />
            <Text style={[styles.attName, mine ? styles.textMine : styles.textTheirs]} numberOfLines={1}>
              {a.name}
            </Text>
          </View>
        ))}
        {message.status === "queued" ? <Text style={styles.queuedNote}>{queuedLabel}</Text> : null}
      </View>
    </View>
  );
}

export default function Chat() {
  const s = useStrings();
  const { client, session, mode, outbox, personStore, signOut } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [batch, setBatch] = useState<PickedMedia[] | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [offlineNote, setOfflineNote] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceUri, setVoiceUri] = useState<string | null>(null);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const playerRef = useRef<AudioPlayer | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const refresh = useCallback(async () => {
    if (!session || !outbox) return;
    try {
      await outbox.flush(session, (item) => client.sendMessage(session, item.text, item.attachments, item.id));
    } catch (err) {
      if (err instanceof AuthError) {
        await signOut();
        return;
      }
      setOfflineNote(true);
    }
    try {
      const [server, pending] = await Promise.all([client.listMessages(session), outbox.list()]);
      setMessages(server);
      setQueued(pending);
      setOfflineNote(pending.length > 0);
    } catch (err) {
      if (err instanceof AuthError) {
        await signOut();
        return;
      }
      setQueued(await outbox.list());
      setOfflineNote(true);
    } finally {
      setLoading(false);
    }
  }, [client, session, outbox, signOut]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  useEffect(() => () => playerRef.current?.remove(), []);

  const sendNow = async (body: string, attachments: NewAttachment[]): Promise<boolean> => {
    if (!session || !outbox) return false;
    if (!body.trim() && attachments.length === 0) return false;
    setSending(true);
    try {
      const report = await submitMessage(client, session, outbox, body.trim(), attachments);
      setText("");
      setQueued(await outbox.list());
      setOfflineNote(report.kept.length > 0);
      await refresh();
      return report.kept.length === 0;
    } catch (err) {
      if (err instanceof AuthError) {
        await signOut();
        return false;
      }
      // Nothing was queued (a full outbox): keep the text so no mail is lost.
      setOfflineNote(true);
      return false;
    } finally {
      setSending(false);
    }
  };

  const retryHeld = async (): Promise<void> => {
    if (!session || !outbox) return;
    setSending(true);
    try {
      const pending = await outbox.list();
      for (const q of pending.filter((q) => q.held === true)) {
        await outbox.release(q.id);
      }
      await refresh();
    } catch (err) {
      if (err instanceof AuthError) {
        await signOut();
        return;
      }
      setOfflineNote(true);
    } finally {
      setSending(false);
    }
  };

  const toNew = (p: PickedMedia): NewAttachment => ({ kind: p.kind, name: p.name, mimeType: p.mimeType, bytesB64: p.bytesB64 });

  const sendPhotos = async (): Promise<void> => {
    try {
      const picked = await pickMailPhotos();
      if (picked.length === 0) return;
      setAttachOpen(false);
      await sendNow(s.mailSent, picked.map(toNew));
    } catch {
      // Permission denied: the person stays in the conversation.
    }
  };

  const sendVideo = async (): Promise<void> => {
    try {
      const picked = (await takeMailVideo()) ?? (await pickMailVideo());
      if (!picked) return;
      setAttachOpen(false);
      await sendNow(s.videoSent, [toNew(picked)]);
    } catch {
      // Permission denied: the person stays in the conversation.
    }
  };

  const batchAddPhoto = async (): Promise<void> => {
    setBatchBusy(true);
    try {
      const photo = await takeMailPhoto();
      if (photo) setBatch((b) => [...(b ?? []), photo]);
    } catch {
      // Permission denied: the batch keeps what it has.
    } finally {
      setBatchBusy(false);
    }
  };

  const batchAddLibrary = async (): Promise<void> => {
    setBatchBusy(true);
    try {
      const picked = await pickMailPhotos();
      if (picked.length > 0) setBatch((b) => [...(b ?? []), ...picked]);
    } catch {
      // Permission denied: the batch keeps what it has.
    } finally {
      setBatchBusy(false);
    }
  };

  const batchAddVideo = async (): Promise<void> => {
    setBatchBusy(true);
    try {
      const picked = (await takeMailVideo()) ?? (await pickMailVideo());
      if (picked) setBatch((b) => [...(b ?? []), picked]);
    } catch {
      // Permission denied: the batch keeps what it has.
    } finally {
      setBatchBusy(false);
    }
  };

  const batchSend = async (): Promise<void> => {
    const items = batch ?? [];
    if (items.length === 0) return;
    setBatchBusy(true);
    setBatch(null);
    setAttachOpen(false);
    await sendNow(s.mailSent, items.map(toNew));
    setBatchBusy(false);
  };

  const toggleRecord = async (): Promise<void> => {
    if (recording) {
      try {
        await recorder.stop();
      } catch {
        // Stopping a failed recording still ends it.
      }
      setRecording(false);
      setVoiceUri(recorder.uri);
      if (recorder.uri && personStore) {
        await trackCacheFile(personStore, recorder.uri).catch(() => {});
      }
      return;
    }
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return;
    try {
      recorder.record();
      setVoiceUri(null);
      setRecording(true);
    } catch {
      setRecording(false);
    }
  };

  const playVoice = (): void => {
    if (!voiceUri) return;
    try {
      playerRef.current?.remove();
      const player = createAudioPlayer(voiceUri);
      playerRef.current = player;
      setVoicePlaying(true);
      player.play();
    } catch {
      setVoicePlaying(false);
    }
  };

  const discardVoice = async (uri: string | null): Promise<void> => {
    setVoiceUri(null);
    setVoicePlaying(false);
    if (uri) await deleteAsync(uri, { idempotent: true }).catch(() => {});
  };

  const sendVoice = async (): Promise<void> => {
    if (!voiceUri) return;
    try {
      const bytesB64 = await fileToB64(voiceUri);
      const uri = voiceUri;
      setVoiceUri(null);
      setVoicePlaying(false);
      setAttachOpen(false);
      await sendNow(s.voiceSent, [{ kind: "voice", name: `voice-${Date.now()}.m4a`, mimeType: "audio/m4a", bytesB64 }]);
      await deleteAsync(uri, { idempotent: true }).catch(() => {});
    } catch {
      // Unreadable recording: the person can record again.
    }
  };

  const queuedAsMessages: ChatMessage[] = queued.map((q) => ({
    id: q.id,
    role: "user",
    text: q.text,
    createdAt: q.createdAt,
    attachments: q.attachments.map((a, i) => ({
      id: `${q.id}-att-${i}`,
      kind: a.kind,
      name: a.name,
      mimeType: a.mimeType,
      size: a.bytesB64.length,
    })),
    status: "queued",
  }));

  const all = [...messages, ...queuedAsMessages];
  const shown = [...all].reverse();
  const heldCount = queued.filter((q) => q.held === true).length;

  if (!session || !outbox) {
    return (
      <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
        <LoadingView />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex} keyboardVerticalOffset={80}>
        <View style={styles.header}>
          <Title>{s.agentTitle}</Title>
          {mode === "stand-in" ? <DemoBanner text={s.demoMode} /> : null}
          {offlineNote ? (
            <View style={styles.offline}>
              <Text style={styles.offlineText}>{s.offline}</Text>
            </View>
          ) : null}
          {heldCount > 0 ? (
            <View style={styles.offline}>
              <Text style={styles.offlineText}>{s.heldNote}</Text>
              <View style={styles.retry}>
                <Btn title={s.retry} onPress={() => void retryHeld()} busy={sending} />
              </View>
            </View>
          ) : null}
        </View>

        {loading ? (
          <View style={styles.empty}>
            <EmptyView body={s.agentEmpty} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={shown}
            keyExtractor={(m) => m.id}
            inverted
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => <Bubble message={item} queuedLabel={s.queued} />}
            ListEmptyComponent={<EmptyView body={s.agentEmpty} />}
          />
        )}

        {batch !== null ? (
          <View style={styles.batch}>
            <Text style={type.cardTitle}>
              {s.mailTitle} ({batch.length})
            </Text>
            <Text style={[type.small, styles.batchBody]}>{s.mailBody}</Text>
            <View style={styles.batchRow}>
              <Pressable onPress={batchAddPhoto} disabled={batchBusy} style={styles.chip} accessibilityRole="button">
                <Ionicons name="camera-outline" size={18} color={colors.text} />
                <Text style={styles.chipText}>{s.mailAddPhoto}</Text>
              </Pressable>
              <Pressable onPress={batchAddLibrary} disabled={batchBusy} style={styles.chip} accessibilityRole="button">
                <Ionicons name="images-outline" size={18} color={colors.text} />
                <Text style={styles.chipText}>{s.attachPhoto}</Text>
              </Pressable>
              <Pressable onPress={batchAddVideo} disabled={batchBusy} style={styles.chip} accessibilityRole="button">
                <Ionicons name="videocam-outline" size={18} color={colors.text} />
                <Text style={styles.chipText}>{s.mailAddVideo}</Text>
              </Pressable>
            </View>
            <View style={styles.batchRow}>
              <Pressable
                onPress={batchSend}
                disabled={batchBusy || batch.length === 0}
                style={[styles.sendBtn, (batchBusy || batch.length === 0) && styles.disabled]}
                accessibilityRole="button"
              >
                <Text style={styles.sendText}>{s.mailSend}</Text>
              </Pressable>
              <Pressable onPress={() => setBatch(null)} style={styles.ghostBtn} accessibilityRole="button">
                <Text style={styles.ghostText}>{s.mailCancel}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {voiceUri ? (
          <View style={styles.voicePreview}>
            <Pressable onPress={playVoice} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={s.voiceSent}>
              <Ionicons name={voicePlaying ? "pause-outline" : "play-outline"} size={22} color={colors.text} />
            </Pressable>
            <Text style={[type.small, styles.voiceName]} numberOfLines={1}>
              {s.voiceSent}
            </Text>
            <Pressable onPress={sendVoice} style={styles.sendBtn} accessibilityRole="button">
              <Text style={styles.sendText}>{s.send}</Text>
            </Pressable>
            <Pressable
              onPress={() => void discardVoice(voiceUri)}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel={s.mailCancel}
            >
              <Ionicons name="trash-outline" size={20} color={colors.alert} />
            </Pressable>
          </View>
        ) : null}

        {attachOpen && batch === null && !voiceUri ? (
          <View style={styles.attachRow}>
            <Pressable onPress={() => setBatch([])} style={styles.attachBtn} accessibilityRole="button">
              <Ionicons name="mail-outline" size={20} color={colors.text} />
              <Text style={styles.attachText}>{s.mailStart}</Text>
            </Pressable>
            <Pressable onPress={sendPhotos} style={styles.attachBtn} accessibilityRole="button">
              <Ionicons name="images-outline" size={20} color={colors.text} />
              <Text style={styles.attachText}>{s.attachPhoto}</Text>
            </Pressable>
            <Pressable onPress={sendVideo} style={styles.attachBtn} accessibilityRole="button">
              <Ionicons name="videocam-outline" size={20} color={colors.text} />
              <Text style={styles.attachText}>{s.attachVideo}</Text>
            </Pressable>
            <Pressable
              onPress={toggleRecord}
              style={[styles.attachBtn, recording && styles.recording]}
              accessibilityRole="button"
              accessibilityLabel={s.attachVoice}
            >
              <Ionicons name="mic-outline" size={20} color={recording ? colors.alert : colors.text} />
              <Text style={styles.attachText}>{recording ? s.recording : s.attachVoice}</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.composer}>
          <Pressable
            onPress={() => setAttachOpen((v) => !v)}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel={s.mailTitle}
          >
            <Ionicons name={attachOpen ? "close-outline" : "add-outline"} size={24} color={colors.text} />
          </Pressable>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={s.composerHint}
            placeholderTextColor={colors.faint}
            style={styles.input}
            multiline
            accessibilityLabel={s.composerHint}
          />
          <Pressable
            onPress={() => void sendNow(text, [])}
            disabled={sending || !text.trim()}
            style={[styles.sendBtn, (sending || !text.trim()) && styles.disabled]}
            accessibilityRole="button"
            accessibilityLabel={s.send}
          >
            <Ionicons name="send-outline" size={20} color={colors.ink} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 16, maxWidth: 640, width: "100%", alignSelf: "center" },
  offline: { backgroundColor: colors.envelope, borderRadius: radius.sm, padding: 10, marginBottom: 8 },
  retry: { marginTop: 8 },
  offlineText: { fontSize: 13, color: colors.text },
  list: { paddingHorizontal: 20, paddingBottom: 12, maxWidth: 640, width: "100%", alignSelf: "center" },
  empty: { flex: 1, paddingHorizontal: 20, paddingTop: 8 },
  bubbleRow: { flexDirection: "row", marginBottom: 10 },
  bubbleRowMine: { justifyContent: "flex-end" },
  bubble: { maxWidth: "85%", borderRadius: radius.md, padding: 12 },
  bubbleMine: { backgroundColor: colors.text },
  bubbleTheirs: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  textMine: { color: colors.ink },
  textTheirs: { color: colors.text },
  attChip: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, opacity: 0.9 },
  attName: { fontSize: 13, flexShrink: 1 },
  queuedNote: { marginTop: 6, fontSize: 12, color: colors.hl, fontWeight: "600" },
  batch: { borderTopWidth: 1, borderTopColor: colors.border, padding: 16, backgroundColor: colors.bg2 },
  batchBody: { color: colors.muted, marginTop: 6, marginBottom: 12 },
  batchRow: { flexDirection: "row", gap: 8, marginBottom: 8, flexWrap: "wrap" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: tapTarget,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border2,
  },
  chipText: { fontSize: 14, fontWeight: "500", color: colors.text },
  voicePreview: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg2 },
  voiceName: { flex: 1, color: colors.text },
  attachRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  attachBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: tapTarget,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.bg2,
  },
  attachText: { fontSize: 14, fontWeight: "500", color: colors.text },
  recording: { backgroundColor: colors.alertSoft },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: colors.border },
  input: {
    flex: 1,
    minHeight: tapTarget,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  iconBtn: { width: tapTarget, height: tapTarget, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.bg2 },
  sendBtn: { minHeight: tapTarget, minWidth: tapTarget, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.text },
  sendText: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  ghostBtn: { minHeight: tapTarget, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.bg2 },
  ghostText: { color: colors.text, fontSize: 15, fontWeight: "500" },
  disabled: { opacity: 0.45 },
});
