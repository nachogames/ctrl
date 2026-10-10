package expo.modules.ctrlappicon

import android.content.ComponentName
import android.content.pm.PackageManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Launcher entries are activity-aliases written by plugins/withCtrlAppIcons.cjs. */
object AppIconAliases {
  val DESIGNS = listOf("outline", "solid", "mac")
  const val DEFAULT_DESIGN = "solid"

  fun component(packageName: String, design: String) =
    ComponentName(packageName, "$packageName.AppIcon${design.replaceFirstChar { it.uppercase() }}")

  fun current(packageManager: PackageManager, packageName: String): String =
    DESIGNS.firstOrNull { design ->
      design != DEFAULT_DESIGN &&
        packageManager.getComponentEnabledSetting(component(packageName, design)) ==
          PackageManager.COMPONENT_ENABLED_STATE_ENABLED
    } ?: DEFAULT_DESIGN

  fun select(packageManager: PackageManager, packageName: String, design: String) {
    require(design in DESIGNS) { "Unknown app icon $design." }
    // Enable the new entry first so the app always has a launcher entry.
    packageManager.setComponentEnabledSetting(
      component(packageName, design),
      PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
      PackageManager.DONT_KILL_APP,
    )
    for (other in DESIGNS) {
      if (other == design) continue
      packageManager.setComponentEnabledSetting(
        component(packageName, other),
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
        PackageManager.DONT_KILL_APP,
      )
    }
  }
}

class CtrlAppIconModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CtrlAppIcon")

    AsyncFunction("getAppIcon") {
      val context = appContext.reactContext ?: error("The app is not active.")
      AppIconAliases.current(context.packageManager, context.packageName)
    }

    AsyncFunction("setAppIcon") { design: String ->
      val context = appContext.reactContext ?: error("The app is not active.")
      AppIconAliases.select(context.packageManager, context.packageName, design)
    }
  }
}
