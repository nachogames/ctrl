package expo.modules.ctrlvoicecall

import android.os.Bundle
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CtrlVoiceCallModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CtrlVoiceCall")

    Events("onAction")

    OnStartObserving("onAction") {
      VoiceCallService.onAction = { action ->
        sendEvent("onAction", Bundle().apply { putString("action", action) })
      }
    }

    OnStopObserving("onAction") {
      VoiceCallService.onAction = null
    }

    Function("start") { caller: String, title: String, status: String, muted: Boolean ->
      appContext.reactContext?.let { VoiceCallService.start(it, caller, title, status, muted) }
    }

    Function("update") { status: String, muted: Boolean ->
      appContext.reactContext?.let { VoiceCallService.update(it, status, muted) }
    }

    Function("stop") {
      appContext.reactContext?.let { VoiceCallService.stop(it) }
    }
  }
}
