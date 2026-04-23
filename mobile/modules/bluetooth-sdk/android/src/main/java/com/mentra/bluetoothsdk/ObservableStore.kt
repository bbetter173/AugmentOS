package com.mentra.bluetoothsdk

import org.json.JSONObject

/** Observable state management with immediate event emission */
class ObservableStore {
    companion object {
        const val BLUETOOTH_CATEGORY = "bluetooth"
        private const val LEGACY_CORE_CATEGORY = "core"

        fun normalizeCategory(category: String): String =
                if (category == LEGACY_CORE_CATEGORY) BLUETOOTH_CATEGORY else category
    }

    private val values = mutableMapOf<String, Any>()
    private var onEmit: ((String, Map<String, Any>) -> Unit)? = null

    fun configure(onEmit: (String, Map<String, Any>) -> Unit) {
        this.onEmit = onEmit
    }

    fun set(category: String, key: String, value: Any) {
        val normalizedCategory = normalizeCategory(category)
        val fullKey = "$normalizedCategory.$key"
        val oldValue = values[fullKey]

        // Skip if unchanged
        if (oldValue != null && toJson(oldValue) == toJson(value)) return

        values[fullKey] = value

        // Emit immediately
        onEmit?.invoke(normalizedCategory, mapOf(key to value))
    }

    fun get(category: String, key: String): Any? = values["${normalizeCategory(category)}.$key"]

    fun getCategory(category: String): Map<String, Any> {
        val prefix = "${normalizeCategory(category)}."
        return values.filterKeys { it.startsWith(prefix) }.mapKeys { it.key.removePrefix(prefix) }
    }

    private fun toJson(value: Any): String {
        return JSONObject(mapOf("v" to value)).toString()
    }
}
