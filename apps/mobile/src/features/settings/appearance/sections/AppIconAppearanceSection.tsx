import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { APP_ICONS } from "@t3tools/contracts";
import { APP_ICON_ARTWORK } from "@t3tools/shared/appIcons";
import { AsyncResult } from "effect/reactivity";
import { Platform, View } from "react-native";

import { AppIconMark } from "../../../../components/AppIconMark";
import { AppText as Text } from "../../../../components/AppText";
import { resolveAppIconPreference } from "../../../../lib/appIconPreference";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsChoiceRow } from "../../components/SettingsChoiceRow";
import { SettingsSection } from "../../components/SettingsSection";

export function AppIconAppearanceSection() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selected = AsyncResult.isSuccess(preferencesResult)
    ? resolveAppIconPreference(preferencesResult.value.appIcon)
    : null;

  return (
    <View className="gap-2">
      <SettingsSection title="App icon">
        {APP_ICONS.map((design, index) => (
          <SettingsChoiceRow
            key={design}
            leading={
              <View className="overflow-hidden rounded-xl bg-black p-1">
                <AppIconMark design={design} tone="color" size={36} />
              </View>
            }
            label={APP_ICON_ARTWORK[design].label}
            description={APP_ICON_ARTWORK[design].description}
            selected={selected === design}
            separated={index > 0}
            disabled={!ready}
            onPress={() => savePreferences({ appIcon: design })}
          />
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {Platform.OS === "ios"
          ? "Changes the home screen icon too. iOS confirms each change."
          : "Changes the home screen icon too. Your launcher may refresh briefly."}
      </Text>
    </View>
  );
}
