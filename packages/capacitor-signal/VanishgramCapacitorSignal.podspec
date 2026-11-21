Pod::Spec.new do |s|
  s.name = 'VanishgramCapacitorSignal'
  s.version = '0.1.1'
  s.summary = 'Native libsignal bridge for the Vanishgram phone apps'
  s.license = 'AGPL-3.0-only'
  s.homepage = 'https://github.com/rossinskiy/vanishgram'
  s.author = 'Vanishgram'
  s.source = { :git => 'https://github.com/rossinskiy/vanishgram.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/VgSignalPlugin/**/*.{swift,h,m}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.dependency 'LibSignalClient'
  s.swift_version = '5.1'
  # LibSignalClient imports the C module SignalFfi; the pods that import LibSignalClient need to see it too.
  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_ROOT}/LibSignalClient/swift/Sources/SignalFfi"',
    'SWIFT_INCLUDE_PATHS' => '$(inherited) "${PODS_ROOT}/LibSignalClient/swift/Sources/SignalFfi"'
  }
end
