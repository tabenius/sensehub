//! Wire framing per `docs/protocol.md`: magic, type, BE length, payload,
//! CRC-16/CCITT over type+length+payload. The streaming parser resynchronises
//! on magic bytes, so a dropped TCP segment or a noisy BT link cannot wedge it.

pub const MAGIC: [u8; 2] = [0x53, 0x48];
pub const MAX_PAYLOAD: usize = 4096;

pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

pub fn encode(msg_type: u8, payload: &[u8]) -> Vec<u8> {
    assert!(payload.len() <= MAX_PAYLOAD);
    let mut out = Vec::with_capacity(5 + payload.len() + 2);
    out.extend_from_slice(&MAGIC);
    out.push(msg_type);
    out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    out.extend_from_slice(payload);
    let mut chk = vec![msg_type, (payload.len() >> 8) as u8, (payload.len() & 0xFF) as u8];
    chk.extend_from_slice(payload);
    out.extend_from_slice(&crc16(&chk).to_be_bytes());
    out
}

/// Incremental parser. Feed it arbitrary chunks; collect complete frames.
#[derive(Default)]
pub struct Parser {
    buf: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub struct Frame {
    pub msg_type: u8,
    pub payload: Vec<u8>,
}

impl Parser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns frames completed by this chunk. Malformed bytes are skipped,
    /// never fatal: callers keep feeding.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Frame> {
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            let start = match self.buf.windows(2).position(|w| w == MAGIC) {
                Some(i) => i,
                None => {
                    self.buf.clear();
                    break;
                }
            };
            if start > 0 {
                self.buf.drain(..start);
            }
            if self.buf.len() < 5 {
                break;
            }
            let len = u16::from_be_bytes([self.buf[3], self.buf[4]]) as usize;
            if len > MAX_PAYLOAD {
                self.buf.drain(..2);
                continue;
            }
            if self.buf.len() < 5 + len + 2 {
                break;
            }
            let mut chk = vec![self.buf[2], self.buf[3], self.buf[4]];
            chk.extend_from_slice(&self.buf[5..5 + len]);
            let want = u16::from_be_bytes([self.buf[5 + len], self.buf[6 + len]]);
            if crc16(&chk) != want {
                self.buf.drain(..2);
                continue;
            }
            frames.push(Frame {
                msg_type: self.buf[2],
                payload: self.buf[5..5 + len].to_vec(),
            });
            self.buf.drain(..7 + len);
        }
        // Bound memory against a peer that never sends magic.
        if self.buf.len() > 8192 {
            self.buf.clear();
        }
        frames
    }
}

/// Decode a SAMPLES payload: (channel, start_seq, samples).
/// An empty sample list is a legitimate heartbeat batch, not malformed input.
pub fn decode_samples(payload: &[u8]) -> Option<(u8, u32, Vec<u16>)> {
    if payload.len() < 5 || (payload.len() - 5) % 2 != 0 {
        return None;
    }
    let channel = payload[0];
    let seq = u32::from_be_bytes([payload[1], payload[2], payload[3], payload[4]]);
    let count = (payload.len() - 5) / 2;
    let mut samples = Vec::with_capacity(count);
    for i in 0..count {
        samples.push(u16::from_be_bytes([payload[5 + 2 * i], payload[6 + 2 * i]]));
    }
    Some((channel, seq, samples))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_split_feeds() {
        let payload: Vec<u8> = (0..200u8).collect();
        let frame = encode(0x02, &payload);
        let mut p = Parser::new();
        assert!(p.feed(&frame[..3]).is_empty());
        let out = p.feed(&frame[3..]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].msg_type, 0x02);
        assert_eq!(out[0].payload, payload);
    }

    #[test]
    fn garbage_resyncs_without_panic() {
        let mut p = Parser::new();
        // Garbage containing false magic, then a fully-formed frame with a
        // corrupted CRC (consumed and rejected), then a good frame.
        let mut bad = encode(0x02, &[0xAA, 0xBB]);
        let last = bad.len() - 1;
        bad[last] ^= 0xFF;
        let mut stream = vec![0xFF, 0x53, 0x00];
        stream.extend_from_slice(&bad);
        let good = encode(0x06, &[0x02, 0x00]);
        stream.extend_from_slice(&good);
        stream.extend_from_slice(&[0x99, 0x53, 0x48]);
        let out = p.feed(&stream);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].msg_type, 0x06);
    }

    #[test]
    fn bad_crc_is_dropped_not_fatal() {
        let mut frame = encode(0x03, &[1, 2, 3]);
        let last = frame.len() - 1;
        frame[last] ^= 0xFF;
        let mut p = Parser::new();
        assert!(p.feed(&frame).is_empty());
        let good = encode(0x03, &[1, 2, 3]);
        assert_eq!(p.feed(&good).len(), 1);
    }

    #[test]
    fn samples_decode_rejects_odd_lengths() {
        assert!(decode_samples(&[0, 0, 0, 0, 0]).is_some());
        assert!(decode_samples(&[0, 0, 0, 0]).is_none());
        assert!(decode_samples(&[0, 0, 0, 0, 0, 1]).is_none());
    }

    #[test]
    fn crc_matches_classic_vector() {
        // "123456789" -> 0x29B1 for CRC-16/CCITT-FALSE.
        assert_eq!(crc16(b"123456789"), 0x29B1);
    }
}
