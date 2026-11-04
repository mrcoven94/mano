// Language follows the person: the device locale picks the default and
// the switch on the sign-in screens or the More screen overrides it. Screens
// read strings through useStrings.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { getLocales } from "expo-localization";
import { noteLanguage } from "./language-now";
import { appStore } from "./storage";
import { stringsFor, type Language, type Strings } from "./strings";

const LANGUAGE_KEY = "language";

interface LanguageState {
  language: Language;
  strings: Strings;
  setLanguage: (language: Language) => Promise<void>;
}

const LanguageContext = createContext<LanguageState>({
  language: "en",
  strings: stringsFor("en"),
  setLanguage: async () => {},
});

function deviceLanguage(): Language {
  try {
    const code = getLocales()[0]?.languageCode ?? "en";
    return code.toLowerCase().startsWith("es") ? "es" : "en";
  } catch {
    return "en";
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(deviceLanguage);
  // A choice made while the saved one is still loading wins over it.
  const chosen = useRef(false);
  noteLanguage(language);

  useEffect(() => {
    appStore
      .get(LANGUAGE_KEY)
      .then((saved) => {
        if (!chosen.current && (saved === "en" || saved === "es")) setLanguageState(saved);
      })
      .catch(() => {});
  }, []);

  // Screen readers and browser translation read the page's language.
  useEffect(() => {
    if (Platform.OS === "web") document.documentElement.lang = language;
  }, [language]);

  const setLanguage = async (next: Language): Promise<void> => {
    chosen.current = true;
    setLanguageState(next);
    await appStore.set(LANGUAGE_KEY, next);
  };

  return (
    <LanguageContext.Provider value={{ language, strings: stringsFor(language), setLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageState {
  return useContext(LanguageContext);
}

export function useStrings(): Strings {
  return useContext(LanguageContext).strings;
}
