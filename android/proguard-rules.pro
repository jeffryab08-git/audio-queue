// Keep Media3 + our service/plugin classes: they are reached through reflection
// (Capacitor plugin registry) and through the manifest (MediaSessionService).
-keep class com.hermes.mediaqueue.** { *; }
-keep class androidx.media3.session.** { *; }
-keep class androidx.media3.exoplayer.** { *; }
-dontwarn androidx.media3.**
