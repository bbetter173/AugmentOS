import {View} from "react-native"

import {Screen, Header} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

export default function MiniApp() {
  const {goBack} = useNavigationHistory()

  return (
    <Screen preset="fixed" safeAreaEdges={[]}>
      <Header
        title="MiniApp"
        titleMode="center"
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        style={{height: 44}}
      />
      <View className="flex-1" />
    </Screen>
  )
}
