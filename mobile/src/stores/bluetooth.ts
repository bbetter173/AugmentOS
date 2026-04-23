import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"
import {BluetoothStatus} from "@mentra/bluetooth-sdk"

interface BluetoothState extends BluetoothStatus {
  setBluetoothStatus: (info: Partial<BluetoothStatus>) => void
  reset: () => void
}

const initialState: BluetoothStatus = {
  // state:
  searching: false,
  searchingController: false,
  micRanking: ["glasses", "phone", "bluetooth"],
  systemMicUnavailable: false,
  currentMic: null,
  searchResults: [],
  wifiScanResults: [],
  lastLog: [],
  otherBtConnected: false,
}

export const useBluetoothStore = create<BluetoothState>()(
  subscribeWithSelector((set) => ({
    ...initialState,

    setBluetoothStatus: (info) => set((state) => ({...state, ...info})),

    reset: () => set(initialState),
  })),
)
