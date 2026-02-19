// WSJT-X UDP message parser
// Parses the QDataStream-based protocol used by WSJT-X
// Reference: https://sourceforge.net/p/wsjt/wsjtx/ci/master/tree/Network/NetworkMessage.hpp

class WSJTXParser {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  readUInt32() {
    const val = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return val;
  }

  readInt32() {
    const val = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return val;
  }

  readUInt8() {
    const val = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return val;
  }

  readBool() {
    return this.readUInt8() !== 0;
  }

  readUInt64() {
    // Read as two 32-bit values
    const high = this.readUInt32();
    const low = this.readUInt32();
    return high * 0x100000000 + low;
  }

  readDouble() {
    const val = this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return val;
  }

  readQString() {
    const length = this.readUInt32();
    if (length === 0xFFFFFFFF) return null;
    if (length === 0) return '';
    // WSJT-X uses utf8-encoded strings with a 4-byte length prefix
    const str = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return str;
  }

  readQUtf8() {
    const length = this.readUInt32();
    if (length === 0xFFFFFFFF) return null;
    if (length === 0) return '';
    const str = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return str;
  }

  remaining() {
    return this.buffer.length - this.offset;
  }
}

// Message type constants
const MessageType = {
  HEARTBEAT: 0,
  STATUS: 1,
  DECODE: 2,
  CLEAR: 3,
  REPLY: 4,
  QSO_LOGGED: 5,
  CLOSE: 6,
  REPLAY: 7,
  HALT_TX: 8,
  FREE_TEXT: 9,
  WSPR_DECODE: 10,
  LOCATION: 11,
  LOGGED_ADIF: 12,
  HIGHLIGHT_CALLSIGN: 13,
  SWITCH_CONFIGURATION: 14,
  CONFIGURE: 15,
};

function parseMessage(buffer) {
  if (buffer.length < 12) return null;

  const parser = new WSJTXParser(buffer);

  // Header: magic number
  const magic = parser.readUInt32();
  if (magic !== 0xadbccbda) return null;

  // Schema version
  const schema = parser.readUInt32();

  // Message type
  const type = parser.readUInt32();

  // Client ID
  const id = parser.readQString();

  const result = { type, id, schema };

  try {
    switch (type) {
      case MessageType.HEARTBEAT:
        result.typeName = 'Heartbeat';
        result.maxSchema = parser.readUInt32();
        result.version = parser.readQString();
        result.revision = parser.readQString();
        break;

      case MessageType.STATUS:
        result.typeName = 'Status';
        result.dialFrequency = parser.readUInt64();
        result.mode = parser.readQString();
        result.dxCall = parser.readQString();
        result.report = parser.readQString();
        result.txMode = parser.readQString();
        result.txEnabled = parser.readBool();
        result.transmitting = parser.readBool();
        result.decoding = parser.readBool();
        if (parser.remaining() >= 4) {
          result.rxDF = parser.readUInt32();
          result.txDF = parser.readUInt32();
        }
        if (parser.remaining() >= 1) {
          result.deCall = parser.readQString();
          result.deGrid = parser.readQString();
          result.dxGrid = parser.readQString();
        }
        if (parser.remaining() >= 1) {
          result.txWatchdog = parser.readBool();
        }
        if (parser.remaining() >= 1) {
          result.subMode = parser.readQString();
          result.fastMode = parser.readBool();
        }
        if (parser.remaining() >= 1) {
          result.specialOperationMode = parser.readUInt8();
        }
        if (parser.remaining() >= 4) {
          result.frequencyTolerance = parser.readUInt32();
          result.trPeriod = parser.readUInt32();
        }
        if (parser.remaining() >= 1) {
          result.configurationName = parser.readQString();
        }
        if (parser.remaining() >= 1) {
          result.txMessage = parser.readQString();
        }
        break;

      case MessageType.DECODE:
        result.typeName = 'Decode';
        result.isNew = parser.readBool();
        result.time = parser.readUInt32(); // ms since midnight
        result.snr = parser.readInt32();
        result.deltaTime = parser.readDouble();
        result.deltaFrequency = parser.readUInt32();
        result.mode = parser.readQString();
        result.message = parser.readQString();
        result.lowConfidence = parser.readBool();
        if (parser.remaining() >= 1) {
          result.offAir = parser.readBool();
        }
        break;

      case MessageType.CLEAR:
        result.typeName = 'Clear';
        if (parser.remaining() >= 1) {
          result.window = parser.readUInt8();
        }
        break;

      case MessageType.QSO_LOGGED:
        result.typeName = 'QSO Logged';
        result.dateTimeOff = parser.readUInt64();
        result.dxCall = parser.readQString();
        result.dxGrid = parser.readQString();
        result.txFrequency = parser.readUInt64();
        result.mode = parser.readQString();
        result.reportSent = parser.readQString();
        result.reportReceived = parser.readQString();
        result.txPower = parser.readQString();
        result.comments = parser.readQString();
        result.name = parser.readQString();
        result.dateTimeOn = parser.readUInt64();
        if (parser.remaining() >= 1) {
          result.operatorCall = parser.readQString();
          result.myCall = parser.readQString();
          result.myGrid = parser.readQString();
        }
        if (parser.remaining() >= 1) {
          result.exchangeSent = parser.readQString();
          result.exchangeReceived = parser.readQString();
        }
        if (parser.remaining() >= 1) {
          result.adifPropagationMode = parser.readQString();
        }
        break;

      case MessageType.CLOSE:
        result.typeName = 'Close';
        break;

      case MessageType.WSPR_DECODE:
        result.typeName = 'WSPR Decode';
        result.isNew = parser.readBool();
        result.time = parser.readUInt32();
        result.snr = parser.readInt32();
        result.deltaTime = parser.readDouble();
        result.frequency = parser.readUInt64();
        result.drift = parser.readInt32();
        result.callsign = parser.readQString();
        result.grid = parser.readQString();
        result.power = parser.readInt32();
        if (parser.remaining() >= 1) {
          result.offAir = parser.readBool();
        }
        break;

      case MessageType.LOGGED_ADIF:
        result.typeName = 'Logged ADIF';
        result.adif = parser.readQString();
        break;

      default:
        result.typeName = `Unknown (${type})`;
        break;
    }
  } catch (e) {
    // Partial parse is ok - return what we have
    result.parseError = e.message;
  }

  return result;
}

module.exports = { parseMessage, MessageType };
