// 테스트가 띄우는 게이트는 이 PC 의 진짜 대기열(~/.gate-queue)에 줄을 서지 않는다 — 서면 다른 작업공간의 전체 테스트가 끝날 때까지
// `npm test` 가 멈춰 서고, 거꾸로 이 테스트가 남의 게이트를 기다리게 만든다. 게이트를 띄우는 테스트 파일은 이 파일을 맨 먼저 import 한다.
// 대기열 자체를 재는 테스트(queue.test.mjs)만 예외이고, 거기서는 GATE_QUEUE_DIR 를 임시 디렉토리로 준다.
process.env.GATE_QUEUE = 'off';
