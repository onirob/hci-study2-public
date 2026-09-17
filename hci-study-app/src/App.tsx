// src/App.tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { FlowProvider } from './context/FlowProvider';
import { FiltersProvider } from './context/FiltersProvider';
import StudyLayout from './layouts/StudyLayout';
import { RootRedirect, FallbackRedirect } from './Redirects';

import Intro from './pages/Intro';
import PreScreenCheck from './pages/PreScreenCheck';
import FamiliarizationDashboard from './pages/FamiliarizationDashboard';
import FamiliarizationChatbot from './pages/FamiliarizationChatbot';
import FamiliarizationTlx from './pages/FamiliarizationTlx';
import FamiliarizationReliance from './pages/FamiliarizationReliance';
import Imc from './pages/ImcPage';
import Dashboard from './pages/Dashboard';
import Chatbot from './pages/Chatbot';

import NasaTlx from './pages/NasaTlx';
import Bdli from './pages/Bdli';
import TechFam from './pages/TechFam';
import Reliance from './pages/Reliance';
import End from './pages/End';

export default function App() {
  return (
    <BrowserRouter>
      <FlowProvider>
        <Routes>
          <Route element={<StudyLayout />}>
            {/* Home → Intro (keep query params) */}
            <Route path="/" element={<RootRedirect />} />

            {/* Pre-task onboarding */}
            <Route path="/intro" element={<Intro />} />


            {/* Surveys */}
            <Route path="/surveys/prescreen" element={<PreScreenCheck />} />
            <Route path="/survey/bdli" element={<Bdli />} />
            <Route path="/survey/techfam" element={<TechFam />} />



            {/* Familiarization (renders the real Dashboard/Chatbot in demo mode) */}
            <Route
              path="/familiarization/dashboard"
              element={
                <FiltersProvider>
                  <FamiliarizationDashboard />
                </FiltersProvider>
              }
            />
            <Route path="/familiarization/chatbot" element={<FamiliarizationChatbot />} />
            <Route path="/familiarization/tlx" element={<FamiliarizationTlx/>} />
            <Route path="/familiarization/reliance" element={<FamiliarizationReliance />} />

            <Route path="/familiarization/imc/:which" element={<Imc />} />
            <Route path="/imc/:which" element={<Imc />} />

            {/* Tasks — same pages, different paths based on assignment */}
            <Route
              path="/dashboard/:taskId"
              element={
                <FiltersProvider>
                  <Dashboard />
                </FiltersProvider>
              }
            />
            <Route path="/chatbot/:taskId" element={<Chatbot />} />

            <Route path="/survey/tlx/:cycle?" element={<NasaTlx />} />
            <Route path="/survey/reliance/:cycle?" element={<Reliance />} />

            {/* End */}
            <Route path="/end" element={<End />} />

            {/* Fallback (keep query params too, just in case) */}
            <Route path="*" element={<FallbackRedirect />} />
          </Route>
        </Routes>
      </FlowProvider>
    </BrowserRouter>
  );
}
