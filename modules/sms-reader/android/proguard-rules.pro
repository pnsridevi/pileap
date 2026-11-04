# expo-task-manager finds ListenerTaskConsumer by its class name, and Android
# finds the receiver and worker by name. Keep them if minification is ever on.
-keep class expo.modules.smsreader.ListenerTaskConsumer { *; }
-keep class expo.modules.smsreader.SmsListenerReceiver { *; }
-keep class expo.modules.smsreader.ListenerSyncWorker { *; }
