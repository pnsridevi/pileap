import { NativeModule, requireNativeModule } from 'expo';

declare class SmsReaderModule extends NativeModule<{}> {
  setValueAsync(value: string): Promise<void>;
}

export default requireNativeModule<SmsReaderModule>('SmsReader');
