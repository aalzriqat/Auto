# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# expo-modules-core: module definitions (expo-print, expo-sharing, etc.) build
# their type providers via a Kotlin reified-generics DSL with no static class
# reference R8 can trace, so it strips them and every module using that DSL
# throws NoClassDefFoundError on first access in a release/minified build.
-keep class expo.modules.** { *; }
-keepclassmembers class expo.modules.** { *; }
-dontwarn expo.modules.**

# Add any project specific keep options here:
