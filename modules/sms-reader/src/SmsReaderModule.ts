import { NativeModule, requireNativeModule } from 'expo';
import { SmsMessage } from './SmsReader.types';

declare class SmsReaderModule extends NativeModule<{}> {
  // Returns filtered bank SMS for a given date window (Layer 0 + Layer 1 applied)
  // fromDays=0, toDays=90  → last 90 days
  // fromDays=90, toDays=180 → 90 to 180 days ago
  getMessages(fromDays: number, toDays: number): Promise<SmsMessage[]>;

  // Returns ALL SMS in a date window with NO filter — raw export only
  getAllMessages(fromDays: number, toDays: number): Promise<SmsMessage[]>;

  // Debug: returns all unique senders + total count from raw inbox
  getAllSenders(): Promise<{ totalCount: number; senders: string[] }>;

  // Returns true if READ_SMS permission is granted
  hasPermission(): Promise<boolean>;
}

export default requireNativeModule<SmsReaderModule>('SmsReader');