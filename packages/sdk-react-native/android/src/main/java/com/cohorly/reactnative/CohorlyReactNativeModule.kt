package com.cohorly.reactnative

import com.cohorly.android.AndroidDeviceInfo
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class CohorlyReactNativeModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "CohorlyReactNative"

    /** Real (non-vendored) dependency on `com.github.cohorly-io.cohorly-android:cohorly-android`
     * (JitPack). `AndroidDeviceInfo.defaultProperties()` keys are `$`-prefixed
     * mixpanel-style names; remapped here to the plain names the JS side
     * (`fetchNativeDeviceInfo` in deviceInfo.ts) expects. */
    @ReactMethod
    fun getDeviceInfo(promise: Promise) {
        val props = AndroidDeviceInfo(reactContext).defaultProperties()
        val map = Arguments.createMap()
        (props["\$app_version_string"] as? String)?.let { map.putString("appVersion", it) }
        props["\$app_build_number"]?.let { map.putString("appBuild", it.toString()) }
        (props["\$model"] as? String)?.let { map.putString("model", it) }
        (props["\$manufacturer"] as? String)?.let { map.putString("manufacturer", it) }
        (props["\$brand"] as? String)?.let { map.putString("brand", it) }
        (props["\$carrier"] as? String)?.let { map.putString("carrier", it) }
        promise.resolve(map)
    }
}
