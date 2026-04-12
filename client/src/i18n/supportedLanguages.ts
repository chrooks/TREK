export const SUPPORTED_LANGUAGES = [
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'hu', label: 'Magyar' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'br', label: 'Português (Brasil)' },
  { value: 'cs', label: 'Česky' },
  { value: 'pl', label: 'Polski' },
  { value: 'ru', label: 'Русский' },
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'it', label: 'Italiano' },
  { value: 'ar', label: 'العربية' },
] as const

export type SupportedLanguageCode = typeof SUPPORTED_LANGUAGES[number]['value']

export const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map(l => l.value)
