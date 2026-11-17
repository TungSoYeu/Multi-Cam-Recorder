import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Image, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useVideoPlayer, VideoView } from 'expo-video';
import { colors } from '../theme';
import { deleteClips, formatBytes, formatDuration, listClips, subscribeClips, type LocalClip } from '../video/library';
import { blockedReason, resumeUploads, subscribeUploads, uploadUi, type UploadUi } from '../video/uploader';

function uploadLabel(u: UploadUi): { text: string; color: string } {
  switch (u.status) {
    case 'done':
      return { text: '✓ Đã tải lên', color: colors.ok };
    case 'hashing':
      return { text: 'Đang chuẩn bị…', color: colors.muted };
    case 'uploading':
      return { text: `⬆ ${Math.round(u.progress * 100)}%`, color: colors.accent };
    case 'paused':
      return { text: 'Tạm dừng', color: '#e5c33a' };
    case 'error':
      return { text: u.message ?? 'Lỗi', color: colors.danger };
    default:
      return { text: 'Chờ tải lên', color: colors.muted };
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateText = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function LibraryTab() {
  const [clips, setClips] = useState<LocalClip[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<LocalClip | null>(null);
  const { width } = useWindowDimensions();
  const tileW = (width - 20 * 2 - 12) / 2;

  const reload = useCallback(() => {
    listClips().then(setClips).catch(() => setClips([]));
  }, []);

  const [, setTick] = useState(0);
  useEffect(() => {
    reload();
    const a = subscribeClips(reload);
    const b = subscribeUploads(() => setTick((t) => t + 1));
    return () => {
      a();
      b();
    };
  }, [reload]);
  const pausedCount = clips.filter((c) => uploadUi(c).status === 'paused').length;
  const blocked = blockedReason();

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  function removeSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    Alert.alert(`Xóa ${ids.length} clip?`, 'Clip sẽ bị xóa khỏi máy này.', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Xóa',
        style: 'destructive',
        onPress: async () => {
          await deleteClips(ids);
          setSelected(new Set());
          setSelecting(false);
        },
      },
    ]);
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={st.header}>
        <Text style={st.title}>{selecting ? `Đã chọn ${selected.size}` : 'Video đã quay'}</Text>
        {clips.length ? (
          <Pressable
            hitSlop={10}
            onPress={() => {
              setSelecting((v) => !v);
              setSelected(new Set());
            }}
          >
            <Text style={st.action}>{selecting ? 'Hủy' : 'Chọn'}</Text>
          </Pressable>
        ) : null}
      </View>

      {pausedCount || blocked ? (
        <Pressable style={st.retry} onPress={resumeUploads} accessibilityRole="button">
          <Text style={st.retryText} numberOfLines={2}>
            {blocked ?? `${pausedCount} clip tải lên bị gián đoạn`} · Thử lại
          </Text>
        </Pressable>
      ) : null}

      <FlatList
        data={clips}
        keyExtractor={(c) => c.id}
        numColumns={2}
        columnWrapperStyle={{ gap: 12 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20, gap: 16, flexGrow: 1 }}
        ListEmptyComponent={
          <View style={st.empty}>
            <Text style={{ fontSize: 40 }}>🎞️</Text>
            <Text style={st.emptyTitle}>Chưa có video nào</Text>
            <Text style={st.muted}>Clip quay trên thiết bị này sẽ hiện ở đây.</Text>
          </View>
        }
        renderItem={({ item }) => {
          const isSel = selected.has(item.id);
          return (
            <Pressable
              style={{ width: tileW }}
              onPress={() => (selecting ? toggle(item.id) : setPlaying(item))}
              onLongPress={() => {
                setSelecting(true);
                toggle(item.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={item.file_name}
            >
              <View style={[st.thumb, { height: tileW * 0.62 }]}>
                {item.thumbnail_uri ? (
                  <Image source={{ uri: item.thumbnail_uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                ) : (
                  <Text style={{ fontSize: 28 }}>🎬</Text>
                )}
                <Text style={st.duration}>{formatDuration(item.duration_ms)}</Text>
                {selecting ? <View style={[st.check, isSel && st.checkOn]}>{isSel ? <Text style={st.checkMark}>✓</Text> : null}</View> : null}
                {(() => {
                  const u = uploadUi(item);
                  const l = uploadLabel(u);
                  return (
                    <>
                      <View style={st.badge}>
                        <Text style={[st.badgeText, { color: l.color }]} numberOfLines={1}>
                          {l.text}
                        </Text>
                      </View>
                      {u.status === 'uploading' || u.status === 'hashing' ? (
                        <View style={st.progressTrack}>
                          <View style={[st.progressBar, { width: `${Math.round(u.progress * 100)}%` }]} />
                        </View>
                      ) : null}
                    </>
                  );
                })()}
              </View>
              <Text style={st.name} numberOfLines={1}>
                {item.file_name}
              </Text>
              <Text style={st.meta}>
                {formatBytes(item.size_bytes)} · {dateText(item.created_at)}
              </Text>
            </Pressable>
          );
        }}
      />

      {selecting ? (
        <View style={st.bottomBar}>
          <Pressable onPress={removeSelected} disabled={!selected.size} style={{ opacity: selected.size ? 1 : 0.4, alignItems: 'center' }}>
            <Text style={{ fontSize: 20 }}>🗑️</Text>
            <Text style={{ color: colors.danger, fontWeight: '600' }}>Xóa</Text>
          </Pressable>
        </View>
      ) : null}

      <Modal visible={!!playing} animationType="slide" onRequestClose={() => setPlaying(null)}>
        {playing ? <Player clip={playing} onClose={() => setPlaying(null)} /> : null}
      </Modal>
    </View>
  );
}

function Player({ clip, onClose }: { clip: LocalClip; onClose: () => void }) {
  const player = useVideoPlayer(clip.uri, (p) => {
    p.loop = false;
    p.play();
  });
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
      <View style={st.playerHeader}>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={{ color: '#fff', fontSize: 16 }}>‹ Đóng</Text>
        </Pressable>
        <Text style={{ color: '#fff', fontWeight: '600', flex: 1, textAlign: 'center' }} numberOfLines={1}>
          {clip.file_name}
        </Text>
        <View style={{ width: 60 }} />
      </View>
      <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls />
      <Text style={st.playerMeta}>
        {formatBytes(clip.size_bytes)} · {formatDuration(clip.duration_ms)} · {clip.container.toUpperCase()} ·{' '}
        {clip.camera_facing === 'front' ? 'Camera trước' : 'Camera sau'}
      </Text>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  action: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  thumb: { borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  duration: { position: 'absolute', right: 6, bottom: 6, color: '#fff', fontSize: 11, fontWeight: '700', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  check: { position: 'absolute', left: 6, top: 6, width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#fff', backgroundColor: 'rgba(0,0,0,0.3)', alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkMark: { color: colors.accentInk, fontWeight: '800', fontSize: 12 },
  badge: { position: 'absolute', right: 6, top: 6, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  badgeText: { color: colors.accent, fontSize: 10, fontWeight: '700', maxWidth: 110 },
  progressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.15)' },
  progressBar: { height: 3, backgroundColor: colors.accent },
  retry: { marginHorizontal: 20, marginBottom: 12, padding: 12, borderRadius: 10, backgroundColor: '#e5c33a1f', borderWidth: 1, borderColor: '#e5c33a66' },
  retryText: { color: '#e5c33a', fontSize: 13, fontWeight: '600' },
  name: { color: colors.text, fontSize: 13, fontWeight: '600', marginTop: 6 },
  meta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 80 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  bottomBar: { flexDirection: 'row', justifyContent: 'center', paddingVertical: 10, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  playerHeader: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  playerMeta: { color: '#aaa', textAlign: 'center', padding: 12, fontSize: 13 },
});
