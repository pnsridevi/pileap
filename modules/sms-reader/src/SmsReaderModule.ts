import { NativeModule, requireNativeModule } from 'expo';
import { SmsMessage } from './SmsReader.types';

declare class SmsReaderModule extends NativeModule<{}> {
  // Returns filtered bank SMS for a given date window (Layer 0 + Layer 1 applied)
  // fromDays=0, toDays=90  → last 90 days
  // fromDays=90, toDays=180 → 90 to 180 days ago
  getMessages(fromDays: number, toDays: number): Promise<SmsMessage[]>;

  // Returns ALL SMS in a date window with NO filter — raw export only
  getAllMessages(fromDays: number, toDays: number): Promise<SmsMessage[]>;

  // [ADD] Returns messages Layer 1 dropped because a currency signal was
  // present but no recognized direction verb was found — logging
  // candidates for Log A (haiku_candidate_log), not transactions. See
  // smsParser.ts's logLayer1Candidates().
  getLayer1Candidates(fromDays: number, toDays: number): Promise<SmsMessage[]>;

  // Debug: returns all unique senders + total count from raw inbox
  getAllSenders(): Promise<{ totalCount: number; senders: string[] }>;

  // Returns true if READ_SMS permission is granted
  hasPermission(): Promise<boolean>;

  // [ADD — Nov 4] SMS listener.
  // Connects a JS task (TaskManager.defineTask) to the native listener so
  // it runs after each bank SMS. Safe to call on every app start.
  registerListenerTask(taskName: string): Promise<void>;

  // Listener events recorded on the phone by the native receiver/job
  // (JSON array string). Upload them, then clear that many.
  // See flushListenerEvents() in src/lib/api/backgroundSyncLog.ts.
  peekListenerEvents(): Promise<string>;
  clearListenerEvents(count: number): Promise<void>;

  // [ADD — build 2] Records a step in the same on-phone log, no network.
  // detailsJson must be a JSON object string.
  recordListenerEvent(event: string, detailsJson: string): Promise<void>;
}

export default requireNativeModule<SmsReaderModule>('SmsReader');