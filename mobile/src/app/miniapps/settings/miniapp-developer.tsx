import {useState, useEffect} from "react"
import {View, TextInput, TouchableOpacity, FlatList, Alert} from "react-native"

import {Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {storage} from "@/utils/storage/storage"

const RECENT_KEY = "miniapp_dev_recent"
const MAX_RECENT = 5

interface RecentDevApp {
  packageName: string
  name: string
  url: string
  timestamp: number
}

export default function MiniappDeveloper() {
  const {push} = useNavigationHistory()
  const [url, setUrl] = useState("")
  const [recent, setRecent] = useState<RecentDevApp[]>([])

  useEffect(() => {
    loadRecent()
  }, [])

  const loadRecent = async () => {
    const result = storage.load<RecentDevApp[]>(RECENT_KEY)
    if (result.is_ok()) {
      setRecent(result.value)
    }
  }

  const saveRecent = async (items: RecentDevApp[]) => {
    setRecent(items)
    storage.save(RECENT_KEY, items)
  }

  const handleScanQR = () => {
    push("/miniapps/settings/miniapp-developer-scanner")
  }

  const handleLoadUrl = async () => {
    if (!url.trim()) return
    try {
      // Fetch miniapp.json for metadata
      const res = await fetch(`${url.trim()}/miniapp.json`)
      const manifest = await res.json()
      const entry: RecentDevApp = {
        packageName: manifest.packageName || "com.dev.unknown",
        name: manifest.name || "Dev Miniapp",
        url: url.trim(),
        timestamp: Date.now(),
      }
      const updated = [entry, ...recent.filter((r) => r.url !== entry.url)].slice(0, MAX_RECENT)
      await saveRecent(updated)
      launchDevMiniapp(entry)
    } catch {
      Alert.alert("Error", `Could not fetch miniapp.json from ${url.trim()}`)
    }
  }

  const launchDevMiniapp = (entry: RecentDevApp) => {
    push("/applet/local", {
      packageName: entry.packageName,
      devUrl: entry.url,
      appName: entry.name,
    })
  }

  return (
    <View style={{flex: 1, padding: 16, backgroundColor: "#111"}}>
      <Text style={{fontSize: 20, fontWeight: "bold", color: "#fff", marginBottom: 16}}>Miniapp Developer</Text>

      <TouchableOpacity
        onPress={handleScanQR}
        style={{backgroundColor: "#333", padding: 16, borderRadius: 8, marginBottom: 12, alignItems: "center"}}>
        <Text style={{color: "#0f0", fontSize: 16}}>Scan QR from Dev Server</Text>
      </TouchableOpacity>

      <View style={{flexDirection: "row", marginBottom: 16}}>
        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="http://192.168.1.50:3000"
          placeholderTextColor="#666"
          style={{flex: 1, backgroundColor: "#222", color: "#fff", padding: 12, borderRadius: 8, marginRight: 8}}
        />
        <TouchableOpacity
          onPress={handleLoadUrl}
          style={{backgroundColor: "#336", padding: 12, borderRadius: 8, justifyContent: "center"}}>
          <Text style={{color: "#fff"}}>Load</Text>
        </TouchableOpacity>
      </View>

      <Text style={{color: "#888", fontSize: 14, marginBottom: 8}}>Recent Dev Miniapps</Text>
      {recent.length === 0 ? (
        <Text style={{color: "#555", textAlign: "center", marginTop: 20}}>No recent dev miniapps</Text>
      ) : (
        <FlatList
          data={recent}
          keyExtractor={(item) => item.url}
          renderItem={({item}) => (
            <TouchableOpacity
              onPress={() => launchDevMiniapp(item)}
              style={{backgroundColor: "#222", padding: 12, borderRadius: 8, marginBottom: 8}}>
              <Text style={{color: "#fff", fontWeight: "bold"}}>{item.name} [dev]</Text>
              <Text style={{color: "#888", fontSize: 12}}>{item.url}</Text>
              <Text style={{color: "#555", fontSize: 10}}>{item.packageName}</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  )
}
