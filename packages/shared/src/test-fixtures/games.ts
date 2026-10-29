// テスト専用のフィクスチャ（index.ts からは export しない）。

/**
 * 合法な手だけで進めた無作為な対局（kifu-vision の `generateMoves` で生成。実在の対局ではない）。
 * 打つ手・成る手・駒を取る手が密に出るので、局面索引の回帰に使う。
 * - `RANDOM_GAME_A`: 250 手（打ち 80・成り 22）
 * - `RANDOM_GAME_B`: 85 手で詰み（打ち 10・成り 2）
 * - `RANDOM_GAME_C`: 160 手（成り 20・成れるのに成らない手 24・打ち 56・直前の手の駒を取り返す手 41）
 */
export const RANDOM_GAME_A: string[] = [
  '6i6h 4a5b 7i7h 1c1d 5i5h 2b1c 5g5f 2c2d 4i3h 7c7d 2g2f 4c4d',
  '7g7f 5b6b 8h4d 5c5d 2h2g 6a7b 4d3c 2a3c 1g1f B*1g 2i1g 1c2b',
  'B*3b 3a3b 6h7g B*5b 5h4i 5b1f 1i1h P*4d 4i4h 1f2g+ P*1f R*6f',
  '6g6f 2g3g 4h5h 3g4g 3h4g P*3d B*3g 1a1b P*3f 2b3a R*2c 9a9b',
  '2c1c+ 3a9g+ 3g8b 7b7c R*7i 7a8b 5h6h B*8h 2f2e 8h7i+ 6h5h R*4e',
  '9i9h 9g8g 7h8g 3c2e B*7h 7i7h 9h9c B*4b P*2b 7h8h 3i2h P*9f',
  '2b2a+ 4e4g+ 5h6i 4g4h 2h3i 4b3c 9c9b+ 4h5g L*4g G*4b 1c1b 5g5f',
  'L*1e 8h8g 7g7h S*6d 7h8g 3b2a 3i3h 1d1e 4g4d L*2c P*9c 9f9g+',
  '3h4g P*4f B*2i 2e3g+ 8i9g P*9a P*5h 5f6f 6i5i 4f4g 1b2b S*9h',
  '9b8a 6f3f N*5g 1e1f 2b3c 4g4h+ 5i6h P*4a 2i6e 4b4c B*1c 4h5h',
  '6h7g 3f7f 7g7f 5h5g R*1i 3g2g 1i6i N*8f 1c2d+ 4c3c P*6f R*5f',
  '6e5f P*2e R*9i 3c2d 1g2e 2d1e P*2h B*2d 4d4c+ 2g2h 4c4d 1e2e',
  '4d5d N*2b P*1b P*5b 8a9a P*9e P*7g 8b9a 5f4g L*1a 9c9b+ 9h8g+',
  '4g7d G*1i P*3f 7c7d 6i3i B*3c 9i5i P*7a 7f8g 1f1g S*3b 2a1b',
  '5d5e 9a9b 3i1i 2e3e G*6g 2h2g 6g5g 6b6a 5g4f 6d7e 5i6i 1g1h+',
  '3b2c+ 2g1g 4f3e P*2a G*5i L*1e P*8e 6a6b L*3h P*1d 5e4d 1b2c',
  '3e3d 9b9c P*5c 8f7h+ 4d3c 2b3d B*8i G*9d 8g9h 7e6f 8i7h S*7c',
  'N*8f P*3a 3c2c 2d5g+ S*5d 6b5c 2c3c 1h1i 5d6c+ R*8a P*9f P*6h',
  '6c5b 5c5b P*6d S*2e 3c3d P*5f N*4h 2e3d 7h5f L*6c 6i7i P*5d',
  '7i6i 9e9f P*2b 6h6i+ 8e8d R*4f 6d6c+ P*6b 6c7c 4f4h+ 5i4h 3d4c',
  'L*8b 6f5e S*2g N*7b R*9a 5g2d 4h3g 4c3b 9a9c 8c8d',
].join(' ').split(' ');

export const RANDOM_GAME_B: string[] = [
  '2h3h 9a9b 3i2h 8b7b 5i5h 5c5d 5h5i 7c7d 7i7h 7a8b 4i3i 5a6b',
  '9g9f 8b9a 8h7i 6a5a 3h5h 7b7c 8i9g 4c4d 5h3h 9a8b 5i4h 5a6a',
  '4h4i 6a7a 2g2f 1a1b 2f2e 4a5b 3g3f 4d4e 2h2g 7d7e 7h8i 1c1d',
  '3f3e 6c6d 3h7h 5b5c 2g3h 3c3d 7h9h 8b9a 3h3g 2b7g 3e3d 6b6c',
  'P*7d 7g6h+ 4i4h P*3e 9h6h 7a7b B*8d 6c7d 3d3c+ 7d8d 6i5h 3a4b',
  '1i1h 8d7d 3c4b B*9d 8i9h 7b6c S*5f 9d6g 5f6g 8c8d B*5i 7d6e',
  '6g7f 6e7f 3g2h 9a8b 6h6d S*8h 6d7d 5d5e P*6i P*6e 7i8h 6c7d',
  'S*6g',
].join(' ').split(' ');

export const RANDOM_GAME_C: string[] = [
  '7i7h 2c2d 5i5h 8b7b 7g7f 7c7d 8h3c 2a3c 8i7g B*7c 2h3h 4c4d',
  '6i7i 7c3g P*3d 3g2f 3d3c+ 2b3c 3h3c+ P*3f B*5f 2f1g+ 1i1g 3f3g',
  '1g1c+ 3g3h+ 4i3h P*3e 3c3e P*3c 5f1b 1a1b N*3d B*4c 3d4b+ 4a4b',
  'B*3g N*1f 3g9a 1f2h+ 9a5e+ 2h3h 5e2h 3h2h L*1d B*1h P*3d 3c3d',
  'P*3c 1h2g 3c3b 4c3b P*1i 2g5d 7h8i 5d2g 3i2h P*1a 3e2d 2g3f+',
  'N*1e G*6f 6g6f P*2b 1c2b P*2f 2d2f 3f2f 1d1b 1a1b G*8f 3a2b',
  '1e2c+ L*8b P*3e R*8e L*9d L*9f 9d9c+ 8a9c P*2g 2f2g 2h2g 9f9g',
  'B*4i 9g9h P*9d P*2h 9d9c 9h9i+ 9c9b L*6h 5h6h 2h2i+ N*2d N*2f',
  'L*3i 2i3i 2d1b+ 2f3h+ 2g3h L*8d 3e3d L*8a 3d3c 2b3c 2c3c 4b3c',
  '9b9a+ P*2d N*5e 8e5e 8f7e 7d7e S*2e G*3e P*3d 3e3d P*2i 3i2i',
  '3h2i 8d8g P*2h 8g8h 8i8h N*2f 2i3h 2f1h+ 1i1h 5e5g L*1g 5g5f',
  '1g1c 5f5i N*3e 3d3e P*3d 5i5f 3d3c+ 5f5h 6h5h N*5f R*8i 9i8i',
  'G*2i 8i8h 7i8h 5f4h+ 5h4h N*9b 9a9b R*5d L*3i 5d5i+ 4h5i S*4b',
  '3c4b 7b4b R*2g P*9d',
].join(' ').split(' ');
