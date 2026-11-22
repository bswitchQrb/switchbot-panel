// DEMO=1 のときに SwitchBot API の代わりに使うダミーデータ。
// 実際の家電には一切アクセスせず、操作に応じてメモリ上の状態だけ変える。

const devices = [
  { deviceId: 'DEMO-LOCK', deviceName: 'スマートロック', deviceType: 'Smart Lock', enableCloudService: true },
  { deviceId: 'DEMO-BOT', deviceName: '給湯器スイッチ', deviceType: 'Bot', enableCloudService: true },
  { deviceId: 'DEMO-CURTAIN', deviceName: '寝室のカーテン', deviceType: 'Curtain', enableCloudService: true },
  { deviceId: 'DEMO-PLUG', deviceName: 'コーヒーメーカー', deviceType: 'Plug Mini (JP)', enableCloudService: true },
  { deviceId: 'DEMO-BULB', deviceName: 'デスクライト', deviceType: 'Color Bulb', enableCloudService: true },
  { deviceId: 'DEMO-METER', deviceName: '書斎', deviceType: 'Meter', enableCloudService: true },
  { deviceId: 'DEMO-HUB', deviceName: 'ハブ', deviceType: 'Hub 2', enableCloudService: false },
];

const remotes = [
  { deviceId: 'DEMO-AC', deviceName: 'エアコン', remoteType: 'Air Conditioner', hubDeviceId: 'DEMO-HUB' },
  { deviceId: 'DEMO-LIGHT', deviceName: 'リビングの照明', remoteType: 'Light', hubDeviceId: 'DEMO-HUB' },
  { deviceId: 'DEMO-TV', deviceName: 'テレビ', remoteType: 'TV', hubDeviceId: 'DEMO-HUB' },
  { deviceId: 'DEMO-FAN', deviceName: '扇風機', remoteType: 'Fan', hubDeviceId: 'DEMO-HUB' },
];

const status = {
  'DEMO-LOCK': { deviceType: 'Smart Lock', battery: 82, lockState: 'locked', doorState: 'closed', calibrate: true },
  'DEMO-BOT': { deviceType: 'Bot', battery: 100, power: 'off', deviceMode: 'pressMode' },
  'DEMO-CURTAIN': { deviceType: 'Curtain', battery: 64, slidePosition: 30, moving: false, calibrate: true },
  'DEMO-PLUG': { deviceType: 'Plug Mini (JP)', power: 'on', voltage: 100.2, weight: 24, electricCurrent: 0.3 },
  'DEMO-BULB': { deviceType: 'Color Bulb', power: 'on', brightness: 80, color: '255:214:170', colorTemperature: 3000 },
  'DEMO-METER': { deviceType: 'Meter', battery: 90, temperature: 23.4, humidity: 48 },
  'DEMO-HUB': {},
};

// 画面を開いたときに「使われている」雰囲気が出るよう、最後の操作を少し入れておく
export function demoLastCommands() {
  const ago = min => Date.now() - min * 60_000;
  return {
    'DEMO-AC': { command: 'setAll', parameter: '26,2,1,on', power: 'on', ac: '26,2,1,on', at: ago(42) },
    'DEMO-LIGHT': { command: 'turnOn', parameter: 'default', power: 'on', at: ago(15) },
    'DEMO-TV': { command: 'turnOff', parameter: 'default', power: 'off', at: ago(180) },
  };
}

function applyCommand(id, command) {
  const s = status[id];
  if (!s) return; // 赤外線リモコンは状態を持たない
  if (command === 'lock') Object.assign(s, { lockState: 'locked' });
  if (command === 'unlock') Object.assign(s, { lockState: 'unlocked' });
  if (/Curtain/.test(s.deviceType)) {
    if (command === 'turnOn') s.slidePosition = 0;
    if (command === 'turnOff') s.slidePosition = 100;
  } else if (s.deviceMode !== 'pressMode') {
    if (command === 'turnOn') s.power = 'on';
    if (command === 'turnOff') s.power = 'off';
  }
}

export async function demoApi(path, init = {}) {
  await new Promise(r => setTimeout(r, 250)); // 通信している感じを出す
  if (path === '/devices') return { deviceList: devices, infraredRemoteList: remotes };

  const m = path.match(/^\/devices\/([^/]+)\/(status|commands)$/);
  if (!m) throw Object.assign(new Error('not found'), { status: 404 });
  const [, id, kind] = m;
  if (!devices.some(d => d.deviceId === id) && !remotes.some(r => r.deviceId === id)) {
    throw Object.assign(new Error('device not found'), { status: 404 });
  }
  if (kind === 'status') return { deviceId: id, ...(status[id] ?? {}) };

  const { command } = JSON.parse(init.body || '{}');
  applyCommand(id, command);
  return {};
}
