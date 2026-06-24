import { NativeModule, requireNativeModule } from 'expo';
import { SmsMessage } from './SmsReader.types';

declare class SmsReaderModule extends NativeModule<{}> {
  // Returns bank SMS messages from the last 90 days.
  // Throws ERR_NO_PERMISSION if READ_SMS not granted.
  getMessages(): Promise<SmsMessage[]>;

  // Returns true if READ_SMS permission is currently granted.
  hasPermission(): Promise<boolean>;
}

export default requireNativeModule<SmsReaderModule>('SmsReader');
