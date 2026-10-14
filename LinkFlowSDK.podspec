require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'LinkFlowSDK'
  s.version      = package['version']
  s.summary      = package['description']
  s.description  = package['description']
  s.homepage     = package['homepage']
  s.license      = package['license']
  s.authors      = package['author']

  s.platforms    = { :ios => '13.0' }
  s.source       = { :git => 'https://github.com/thelinkflow/linkflow-react-native-sdk.git', :tag => "#{s.version}" }

  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.swift_version = '5.0'
  s.requires_arc = true

  s.frameworks = 'UIKit', 'Foundation', 'AdSupport', 'AppTrackingTransparency', 'StoreKit'
  # iOS 17.4+ only; weak so the SDK still loads on older systems.
  s.weak_frameworks = 'AdAttributionKit'

  # Pull in React Native using the modern helper when available so the pod
  # works with both the old and new React Native architectures without any
  # Podfile changes from the integrating app.
  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency 'React-Core'
  end
end
