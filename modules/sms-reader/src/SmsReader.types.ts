export interface SmsMessage {
  id:      string;
  address: string; // sender shortcode e.g. "HDFCBK"
  body:    string; // raw SMS text
  date:    number; // epoch milliseconds
}
// Define your exported module types here.
