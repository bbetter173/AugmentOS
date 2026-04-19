import {HashRouter, Navigate, Route, Routes} from "react-router-dom"

import CaptionsPage from "./pages/CaptionsPage"
import TesterMenu from "./pages/tester/TesterMenu"
import StoragePage from "./pages/tester/StoragePage"
import SystemPage from "./pages/tester/SystemPage"
import AudioPage from "./pages/tester/AudioPage"
import LedPage from "./pages/tester/LedPage"
import EventsPage from "./pages/tester/EventsPage"
import DisplayPage from "./pages/tester/DisplayPage"
import ComingSoonPage from "./pages/tester/ComingSoonPage"

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<CaptionsPage />} />
        <Route path="/tester" element={<TesterMenu />} />
        <Route path="/tester/storage" element={<StoragePage />} />
        <Route path="/tester/display" element={<DisplayPage />} />
        <Route path="/tester/audio" element={<AudioPage />} />
        <Route path="/tester/led" element={<LedPage />} />
        <Route path="/tester/system" element={<SystemPage />} />
        <Route path="/tester/events" element={<EventsPage />} />
        <Route path="/tester/coming-soon" element={<ComingSoonPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
