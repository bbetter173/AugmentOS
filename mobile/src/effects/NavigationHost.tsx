import {useEffect} from "react"
import {BackHandler} from "react-native"
import {usePathname} from "expo-router"
import {useNavigationStore} from "@/stores/navigation"

export default function NavigationHost() {
  const pathname = usePathname()

  useEffect(() => {
    useNavigationStore.getState()._trackPathname(pathname)
  }, [pathname])

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      const {preventBack, androidBackFn, goBack} = useNavigationStore.getState()
      if (!preventBack) {
        goBack()
        return true
      }
      androidBackFn?.()
      return true
    })
    return () => sub.remove()
  }, [])

  return null
}