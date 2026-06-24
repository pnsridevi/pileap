import { NativeModule, requireNativeModule } from 'expo';
import { SmsMessage } from './SmsReader.types';

declare class SmsReaderModule extends NativeModule<{}> {
  // Returns filtered bank SMS from last 90 days
  getMessages(): Promise<SmsMessage[]>;

  // Debug: returns all unique senders + total count from raw inbox
  getAllSenders(): Promise<{ totalCount: number; senders: string[] }>;

  // Returns true if READ_SMS permission is granted
  hasPermission(): Promise<boolean>;
}

export default requireNativeModule<SmsReaderModule>('SmsReader');
