import { useRef } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from './ui';
import { colors } from '../theme';

/** Lấy mã mời 6 ký tự từ nội dung QR (QR chứa đúng mã mời). */
export function parseInvite(text: string): string | null {
  const m = text.toUpperCase().match(/\b[A-Z0-9]{6}\b/);
  return m ? m[0] : null;
}

export function QrScanner({ visible, onClose, onCode }: { visible: boolean; onClose: () => void; onCode: (code: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} onShow={() => {
        done.current = false;
      }}>
      <SafeAreaView style={st.wrap}>
        <Text style={st.title}>Quét mã QR phòng</Text>
        <Text style={st.sub}>Hướng camera vào mã QR trên màn hình Controller</Text>
        <View style={st.frame}>
          {permission?.granted ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                const code = parseInvite(data);
                if (code && !done.current) {
                  done.current = true;
                  onCode(code);
                }
              }}
            />
          ) : (
            <View style={st.center}>
              <Text style={st.sub}>Ứng dụng cần quyền camera để quét mã QR.</Text>
              <Button
                title={permission?.canAskAgain === false ? 'Mở Cài đặt để cấp quyền' : 'Cấp quyền camera'}
                onPress={requestPermission}
                style={{ marginTop: 12 }}
              />
            </View>
          )}
        </View>
        <Button title="Đóng" variant="secondary" onPress={onClose} />
      </SafeAreaView>
    </Modal>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, padding: 20, gap: 12 },
  title: { color: colors.text, fontSize: 22, fontWeight: '700', marginTop: 8 },
  sub: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  frame: { flex: 1, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000', borderWidth: 2, borderColor: colors.accent },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
});
