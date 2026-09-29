import { createRoot } from 'react-dom/client';
import { SettingsForm } from './components/SettingsForm';
import './styles/style.css';
import { initLocale, t } from '../i18n';
import { useLocale } from './use-locale';

function SettingsPage() {
  useLocale(() => `BWAI · ${t('settings.title')}`);
  return <SettingsForm/>;
}
void initLocale().then(() => createRoot(document.getElementById('root')!).render(<SettingsPage/>));
