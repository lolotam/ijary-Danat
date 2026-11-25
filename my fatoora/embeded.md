# Embedded Payment

# Embedded Integration

The Embedded Integration allows you to integrate a seamless payment experience directly on your website, enabling customers to choose from payment methods that are enabled for your account. With a single integration, you can offer a unified checkout interface that blends perfectly with your website’s design, providing a consistent and user-friendly experience. This ensures that customers can easily select their preferred payment method and complete transactions in just a few clicks.

## **Key Features**

- **PCI DSS Compliance**: MyFatoorah handles all PCI DSS requirements; no certification needed on your end
- **Unified Integration**: A Single JavaScript library supports all payment methods
- **Flexible Payment Options**: Embedded and Hosted Methods Together
- **Customizable UI**: Control which payment methods to display and handle redirections

## **Supported Payment Methods**

**Embedded Payment Methods** (processed on your page without redirection):

- Cards (Visa / Mastercard / AMEX, etc.)
- Apple Pay
- Google Pay
- STC Pay

**Other Payment Methods (Hosted):**

- MyFatoorah automatically shows all payment methods enabled in your account. Payments not supported in embedded will redirect to the hosted payment page.

<Image align="center" alt="Embedded Integration View" caption="Embedded Integration View" src="https://files.readme.io/9ed0c580476c2cc88b3b646dd192711f3c3b807876df5284578a89a3feaab7ae-embedded.PNG" />

> 📘 Enable Payment Methods
>
> To enable payment methods on your Live account, please contact your [Account Manager](https://www.myfatoorah.com/en/contact-us/).\
> To enable payment methods on your Demo account, kindly send a request to <tech@myfatoorah.com> .

## **Before You Start**

### **Prerequisites**

1. **MyFatoorah Demo Account**: Create your test account at [MyFatoorah Portal](https://registertest.myfatoorah.com/en/)
2. **API Key**: Generate your test API key from the portal (or you can also use a test token [here](https://docs.myfatoorah.com/docs/test-token))
3. **Webhook Configuration**: Set up a [webhook](https://docs.myfatoorah.com/docs/webhook-information) endpoint to receive payment status notifications

### **Environment URLs**

| Environment                       | API Base URL                      |
| --------------------------------- | --------------------------------- |
| **Sandbox**                       | `https://apitest.myfatoorah.com/` |
| **Kuwait, Bahrain, Jordan, Oman** | `https://api.myfatoorah.com/`     |
| **UAE**                           | `https://api-ae.myfatoorah.com/`  |
| **Saudi Arabia**                  | `https://api-sa.myfatoorah.com/`  |
| **Qatar**                         | `https://api-qa.myfatoorah.com/`  |
| **Egypt**                         | `https://api-eg.myfatoorah.com/`  |

> 🚧 Important
>
> Always use the **/v3/endpoint** for this integration.\
> For example: <https://apitest.myfatoorah.com/v3/sessions>\
> Older versions /v2 should not be used for new integrations.

> 🚧 Apple Pay Prerequisites
>
> To enable Apple Pay, you must verify your domain. For detailed instructions, please refer to our [Apple Pay Domain Verification Guide.](https://docs.myfatoorah.com/docs/apple-pay-domain-verification)

## **Integration Modes**

MyFatoorah Embedded integration offers two distinct integration modes to suit different business needs:

### **1. Complete Payment Mode** (Default)

- Use when you want the **entire payment process** to happen in **one API call**.
- Ideal for simple checkout flows.

### **2. Collect Details Mode**

- Use when you want to collect payment details first, and then complete payment.
- Ideal for complex pricing scenarios or when the final amount may change.

# How it works

## **Mode 1: Complete Payment**

This mode handles the entire payment process in a single flow, ideal for straightforward payment scenarios.

### **Step 1: Create Payment Session**

Make a server-side API call to create a new payment session. You need to do this for each payment separately. SessionId is valid for only one payment.

**Endpoint:**`POST /v3/sessions` ([Create Session](https://docs.myfatoorah.com/reference/create-session))

```json Request Example
{
  "PaymentMode": "COMPLETE_PAYMENT",
  "Order": {
    "Amount": 10
  }
}
```

```json Response
{
  "IsSuccess": true,
  "Message": "Created Successfully!",
  "ValidationErrors": null,
  "Data": {
    "SessionId": "KWT-68814db6-7510-4005-ada9-408aae9f373c",
    "SessionExpiry": "2025-10-02T00:52:35.6000597Z",
    "EncryptionKey": "m2QTkGqSxy24hpRGmoJ50vk6cfz4VJITNxGe5/uO+Qo=",
    "OperationType": "PAY",
    "Order": {
      "Amount": 10.0,
      "Currency": "KWD",
      "ExternalIdentifier": null
    },
    "Customer": {
      "Reference": null,
      "Cards": null
    }
  }
}
```

### **Step 2: Initialize Client-Side Integration**

**Include JavaScript Library:**

```html
// Test Environment
<script src="https://demo.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Kuwait, Bahrain, Jordan, and Oman
<script src="https://portal.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For UAE
<script src="https://ae.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Saudi Arabia
<script src="https://sa.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Qatar
<script src="https://qa.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Egypt
<script src="https://eg.myfatoorah.com/sessions/v1/session.js"></script>
```

**Create Container Element:**

You need to define a div element with a unique id attribute. The Unified Session will be loaded inside this div after passing the div id to the configuration variable.

```html
<div id="embedded-sessions"></div>
```

**Configure and Initialize:**

Now you need to add the configuration variables. Place the following snippet in a new script tag after loading the JavaScript library, and replace the **sessionId** parameter with the "SessionId" you receive from the `POST /v3/sessions` Endpoint.

```javascript
var config = {
  sessionId: "KWT-68814db6-7510-4005-ada9-408aae9f373c", // Add the "SessionId" you received from POST Session Endpoint.
  callback: payment, // MyFatoorah triggers this callback after the customer completes payment, either by submitting card details, finishing Google Pay / Apple Pay / STC Pay, or choosing any hosted payment method.
  containerId: "embedded-sessions", //Enter the div id you created in previous step.
  shouldHandlePaymentUrl: true, // Default true
};

myfatoorah.init(config);

function payment(response) {
  console.log(JSON.stringify(response));
}
```

### **Step 3: Handle Payment Response**

The callback function response depends on `shouldHandlePaymentUrl` setting in the config object and the payment method chosen.

- **If shouldHandlePaymentUrl: true (default):**
  - Embedded Methods (Card/Apple/Google/STC Pay):\
    MyFatoorah handles the OTP page. After that, you will receive `paymentCompleted: true` (This does not indicate the payment status, only that the payment flow was completed successfully). To retrieve the actual payment status, use the `paymentData` received in the callback function along with the `EncryptionKey` obtained from the POST session endpoint to decrypt the response and determine the final payment status.

    ```json Callback Response
    {
      "isSuccess": true,
      "sessionId": "KWT-82b22745-c777-436a-a30f-dc89c06f333b",
      "paymentCompleted": true,
      "paymentData": "GA7UWznbZznsnkm5CILO0CRoYF0z1Fbnk+5Yp7Hb53+dRsAMrZE3SlDAveN/g6hnv3zhQKWMPxbn73ul7//Db2uMiA2QOTeXMJi+vkjxX4uynpF4mcY/EOU29ZExpM/FfCQe1p34NJjaPEJ8APvqM0s1NPWLV0Qg8eNnrEMKbTAFUeYuAWmaGa5gfdDdVHvcksCw4SQTs1MCCTxM2sdOeBKGz/FD75nmsphrhl8bTrDWzVMx6JvalOTONg9rg2gVsXDwnpwT6CTbR9mlkW1UHsxecOXcGPYBfVh8LhuaLCQmKw6msPEoaVvJs02cQALTAOOZdQOEMRxk3hgUrdlTWwgzRs/Ud+XYK4ZRH4r6VRSM3S8oVbZs4WVuPZAKcRqqRaxT/quiEZmrnZbGE+XWpAl8qCE0idN9xYGGtmBQXTxQQUThLGtNirSUlLNUT7sTVwb5qHjhw9zSQTc01nO8unBvZFrBfavymsg7dLmBTeF1rGxsCkp4s72yXgPCsLS+XlVCQdOz1d1kEAx8ZkGAvAh7tPS+bA1d3YghRco4JOpYD+sTpGJM72ngsKGst+PiyQbvxoMuKMnN7fCU8ZAPEy9CRWi3DqIM2mHKrF6qo9kLaxD1LqD1FJUZ4oK6ueh5bFWFGatbg4QW5hYiZ/hkd4UBNfSl0RygU6u/UpnwAeIBzN9i+cSTa+QDylKmxnDUK+MVI8PzT7dq9tkNYBpuK/az/bG1DgqD5UTGDINBIHlWtgZ0c0OzkR8Xto7MA/VpAdi0BSAEr5lmpjZ/LDSr1j3rxjvdRi92Uockp9iFGZiYi8JabYikZhb/AlXa1fhmwcvXuGQmZqbFwNI8zyqX5O7JEuD7UDZ3GQiXk4gQl1Vn/1T6eiH0dTfQ+EMczdFvnpCGzdt2j6jJ17AEjVV814UjY4spI6Hii1uKTQEuY8ftXXqpyHD5CROhBCmsIrOrR1HXrP58y7D8FmeMOy4IhtUmO/fDj3JjSJ2oDvMRZsTzaYMUyhzfOZXZ9vl8hNY61ObgMh9EXsoSX5zRjsRfabi+0GG//+Efm/5ahmBKFj+RuGtBrpttB75M1h4LsWnBa7iBeq3cqOSzvuqlJZPeWaN1MTrdeH+lyWciMzlRIEXuIWWGqRpEpjOKKfpdpx6LPdYYWtGJwgctKvrftEqxEyWPabBAvCNq/lzxZJpn5WBjhaZn0h8h+yazcWBwzYDoxktvm9nY8cPvk9RQvcp3CPvYfSviSFnMtkd/LAVsi2pTOUik0Xg3vvLNWGTVc6USjWIo+sZoFI4Q3GaVW8d3L0twI1N0l7YMVzK/xL0rx2fcFMLuXMcY6kGC3npTQSH603CjO+6adqnhoJ7Ah3eFidBvqsItaTUR9QRc396Sa52uRp7KPiRqkTqy03jFEQ611X4KCa+ZRbw1oZmpLcUdsOmfl7ETbmcPBzKF0aXlbBArCddv0YPQK1OrxsquV/9mZI5AAVDDXJShaYrlQ9+CKgGuLDp6hGX1mYEjWEc+yR5iAm/T7nrfHKZz/DuFD3V+ok0Upni1HQbHJ3AQj6qhwQ==",
      "paymentType": "CARD",
      "redirectionUrl": "https://demo.MyFatoorah.com/En/KWT/PayInvoice/Result?paymentId=07076389179322432673"
    }
    ```

    Here is a sample code snippet showing how to decrypt `paymentData` and get the actual payment status:

    ```python
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import unpad
    import base64

    def decrypt_with_key(encrypted_text, encryption_key):
        try:
            # Decode base64 encrypted text and key
            encrypted_text_bytes = base64.b64decode(encrypted_text)
            pass_bytes = encryption_key.encode('utf-8')

            # Prepare 16-byte key (128-bit)
            encryption_key_bytes = bytearray(16)
            len_pass = min(len(pass_bytes), len(encryption_key_bytes))
            encryption_key_bytes[:len_pass] = pass_bytes[:len_pass]

            # Initialize AES cipher in CBC mode
            cipher = AES.new(bytes(encryption_key_bytes), AES.MODE_CBC, iv=bytes(encryption_key_bytes))

            # Decrypt and unpad
            decrypted_bytes = cipher.decrypt(encrypted_text_bytes)
            decrypted_text = unpad(decrypted_bytes, AES.block_size)

            return decrypted_text.decode('utf-8')
        except Exception:
            return "FAILED"

    # Input values
    encryption_key = "m2QTkGqSxy24hpRGmoJ50vk6cfz4VJITNxGe5/uO+Qo="

    encrypted_text = "AycwHsyRddykBFQ1Nojm+E/tQLa0eUiHDBTBjC+QUz5zWANVbCtQV4aOZZd4FBcUGv3fG3wJHTs4C0G1JoiZS49c4KCY1ePKWLUV14ZWcn2VCUU5KtWkJI3WTVxUBJgXKK1gzTVH7KMVSLCgnjaO5cBm+GNMBohn929BUi8BSJX8LvSJDwq8a1mFmdCgbLuZ7ozqCcJchlPRj4/Pfx1ihjyzhrOyY2q9610t+QjdXKokON31EFBRQK6LIbaYBi9fghMpbxrrDIBAbCdnKhN+sWuWD6/AD7KSbYS+A0OzsbZ/EDvCrk7H+IkvxsrgnaiFPwb7pa83ZfXJUsLDG7fB3NK9m3KqaG0ScVQZ8hMVKS3NQi+kHoMZmuNEhvCM8XNWQE82AR92MrDpCMhMLShxwpU+d+/ArF2hF/tYY2ersrgpWrNW6jUawcSGoiJtAyHAIt4EV5S1Qp6UrwcEbC4SSuF3cD0aLSP1GZ/KSBFJLsahydHyJkMp/xn+hr7ICmMq0LqdtdR0Uh9sToQT+3UCIHofjhiwVXVUkKCJqDqKR3rYOYARXmnkA0GIwPhRctQgTYYvmcubUTssc3faV5vrm8sAyowaHDCt3kLvhJjQek/qO0BapqY3SSJBN6xc1uDwND0VyPe2/TaGrzjqPrT7bTVsLmiX/f1oatV8GsW3oRzfNK9nfgAQfWcWjGPZ5Yqmz3ayLUtOZotIIar3240Obli/nUVeK3ev0h7pWK6rEKLP4S/8Dhz4T4fqv8z8CnJ2VWIkTU9Cx1xtJLnsRwXZJnO8tlfiq3/XrcS8SBaNQ8YdLuXsw083HVXCR8addSqUAYu8rn7dQ3o3CnkecxfPGhj+aZ+n/cRHUBuM47Svn4JMFdZF3Fz3iTlWqU7JFNNYAHaXlnLx+/klCgvwIxi2/puoLGSkIpR9hXG1ARQpNwGB5JGRlo4yG5jhlp5FeWDFFKn0O9p2JlRCyhZH9H16WjKFXyt2nlgNDr2J/WrCQ0lzfVYBxIa3r6gRMOcWVw0rTyaFHWTmHr6VhNYFn2gX9Ii4riu5bRPYyjGe6DkGVLuvIRPFaYaRe/UhyaosAv8IWSQDuERE7qijW1a/bLxqmSXf4kwytNbfDjJpf4Pb3srC2m6TfiOS0BcX6VAALH0q97D005Eb4ksc9Oy+HVofpA+cNKrKftrySBsUqnLhT532E9AnShAKBGoIG//+CTWmVvF4aCzMdkaHBAkkaGYl/ugy2bdEq69J+ZqcRW35cRqJdKHdmQhq31oVdUqgcYVTrNCc4rnZc2bgVvjAw0gNCcQHJXRFkz7kzBOW+FoYBnWteUvy9Emf+FIw3gNgjKRaMRbeUB/QHVkccLn/KaTigxlmDBzS6H1gM7YMhXdaPlxw9TCGbt07DmSuupIk9S3GzaZHC4RSpU2gjMcXiyJMY/iZSG88BJvayWWEnFiF72dj9NvNl9zGEJlBv6vpVzVjFO45hVHaACe/M+j8tTfJg4+duW+k1CXDk5gbjW+TBGde0uBc/9wxkw77CFB65g/dc4449HpkoEKmI3DCOtqChcfIuFXNJI6zfH4aXYfyM7OoRDRFOe2MvBZqy8i7W8unAZ6xXXrOKBZ1gIdKOOqjWQ=="
    # Decrypt and print result
    result = decrypt_with_key(encrypted_text, encryption_key)
    print(result)
    ```

    ```csharp
    using System;
    using System.Security.Cryptography;
    using System.Text;

    namespace Decrypt_New_API
    {
        internal class Program
        {
            static void Main(string[] args)
            {
                var result = DecryptWithKey(
    "AycwHsyRddykBFQ1Nojm+E/tQLa0eUiHDBTBjC+QUz5zWANVbCtQV4aOZZd4FBcUGv3fG3wJHTs4C0G1JoiZS49c4KCY1ePKWLUV14ZWcn2VCUU5KtWkJI3WTVxUBJgXKK1gzTVH7KMVSLCgnjaO5cBm+GNMBohn929BUi8BSJX8LvSJDwq8a1mFmdCgbLuZ7ozqCcJchlPRj4/Pfx1ihjyzhrOyY2q9610t+QjdXKokON31EFBRQK6LIbaYBi9fghMpbxrrDIBAbCdnKhN+sWuWD6/AD7KSbYS+A0OzsbZ/EDvCrk7H+IkvxsrgnaiFPwb7pa83ZfXJUsLDG7fB3NK9m3KqaG0ScVQZ8hMVKS3NQi+kHoMZmuNEhvCM8XNWQE82AR92MrDpCMhMLShxwpU+d+/ArF2hF/tYY2ersrgpWrNW6jUawcSGoiJtAyHAIt4EV5S1Qp6UrwcEbC4SSuF3cD0aLSP1GZ/KSBFJLsahydHyJkMp/xn+hr7ICmMq0LqdtdR0Uh9sToQT+3UCIHofjhiwVXVUkKCJqDqKR3rYOYARXmnkA0GIwPhRctQgTYYvmcubUTssc3faV5vrm8sAyowaHDCt3kLvhJjQek/qO0BapqY3SSJBN6xc1uDwND0VyPe2/TaGrzjqPrT7bTVsLmiX/f1oatV8GsW3oRzfNK9nfgAQfWcWjGPZ5Yqmz3ayLUtOZotIIar3240Obli/nUVeK3ev0h7pWK6rEKLP4S/8Dhz4T4fqv8z8CnJ2VWIkTU9Cx1xtJLnsRwXZJnO8tlfiq3/XrcS8SBaNQ8YdLuXsw083HVXCR8addSqUAYu8rn7dQ3o3CnkecxfPGhj+aZ+n/cRHUBuM47Svn4JMFdZF3Fz3iTlWqU7JFNNYAHaXlnLx+/klCgvwIxi2/puoLGSkIpR9hXG1ARQpNwGB5JGRlo4yG5jhlp5FeWDFFKn0O9p2JlRCyhZH9H16WjKFXyt2nlgNDr2J/WrCQ0lzfVYBxIa3r6gRMOcWVw0rTyaFHWTmHr6VhNYFn2gX9Ii4riu5bRPYyjGe6DkGVLuvIRPFaYaRe/UhyaosAv8IWSQDuERE7qijW1a/bLxqmSXf4kwytNbfDjJpf4Pb3srC2m6TfiOS0BcX6VAALH0q97D005Eb4ksc9Oy+HVofpA+cNKrKftrySBsUqnLhT532E9AnShAKBGoIG//+CTWmVvF4aCzMdkaHBAkkaGYl/ugy2bdEq69J+ZqcRW35cRqJdKHdmQhq31oVdUqgcYVTrNCc4rnZc2bgVvjAw0gNCcQHJXRFkz7kzBOW+FoYBnWteUvy9Emf+FIw3gNgjKRaMRbeUB/QHVkccLn/KaTigxlmDBzS6H1gM7YMhXdaPlxw9TCGbt07DmSuupIk9S3GzaZHC4RSpU2gjMcXiyJMY/iZSG88BJvayWWEnFiF72dj9NvNl9zGEJlBv6vpVzVjFO45hVHaACe/M+j8tTfJg4+duW+k1CXDk5gbjW+TBGde0uBc/9wxkw77CFB65g/dc4449HpkoEKmI3DCOtqChcfIuFXNJI6zfH4aXYfyM7OoRDRFOe2MvBZqy8i7W8unAZ6xXXrOKBZ1gIdKOOqjWQ==",
                    "m2QTkGqSxy24hpRGmoJ50vk6cfz4VJITNxGe5/uO+Qo="
                );

                Console.WriteLine(result);
            }

            public static string DecryptWithKey(string EncryptedText, string Encryptionkey)
            {
                try
                {
                    RijndaelManaged objrij = new RijndaelManaged();
                    objrij.Mode = CipherMode.CBC;
                    objrij.Padding = PaddingMode.PKCS7;

                    objrij.KeySize = 0x80;
                    objrij.BlockSize = 0x80;
                    byte[] encryptedTextByte = Convert.FromBase64String(EncryptedText);
                    byte[] passBytes = Encoding.UTF8.GetBytes(Encryptionkey);
                    byte[] EncryptionkeyBytes = new byte[0x10];
                    int len = passBytes.Length;
                    if (len > EncryptionkeyBytes.Length)
                    {
                        len = EncryptionkeyBytes.Length;
                    }
                    Array.Copy(passBytes, EncryptionkeyBytes, len);
                    objrij.Key = EncryptionkeyBytes;
                    objrij.IV = EncryptionkeyBytes;
                    byte[] TextByte = objrij.CreateDecryptor().TransformFinalBlock(encryptedTextByte, 0, encryptedTextByte.Length);
                    return Encoding.UTF8.GetString(TextByte);  //it will return readable string
                }
                catch (Exception)
                {

                    return "";
                }

            }
        }
    }
    ```

    ```node Node.js
    import { createDecipheriv } from "crypto";

    function decryptWithKey(encryptedText, encryptionKey) {
      try {
        const encryptedTextBytes = Buffer.from(encryptedText, "base64");

        const passBytes = Buffer.from(encryptionKey, "utf-8");

        let encryptionKeyBytes = Buffer.alloc(16);
        passBytes.copy(encryptionKeyBytes, 0, 0, Math.min(passBytes.length, 16));

        const decipher = createDecipheriv("aes-128-cbc", encryptionKeyBytes, encryptionKeyBytes);

        let decrypted = decipher.update(encryptedTextBytes);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString("utf-8");
      } catch (err) {
        return "FAILED";
      }
    }

    const encryptionKey = "m2QTkGqSxy24hpRGmoJ50vk6cfz4VJITNxGe5/uO+Qo=";

    const encryptedText =
      "AycwHsyRddykBFQ1Nojm+E/tQLa0eUiHDBTBjC+QUz5zWANVbCtQV4aOZZd4FBcUGv3fG3wJHTs4C0G1JoiZS49c4KCY1ePKWLUV14ZWcn2VCUU5KtWkJI3WTVxUBJgXKK1gzTVH7KMVSLCgnjaO5cBm+GNMBohn929BUi8BSJX8LvSJDwq8a1mFmdCgbLuZ7ozqCcJchlPRj4/Pfx1ihjyzhrOyY2q9610t+QjdXKokON31EFBRQK6LIbaYBi9fghMpbxrrDIBAbCdnKhN+sWuWD6/AD7KSbYS+A0OzsbZ/EDvCrk7H+IkvxsrgnaiFPwb7pa83ZfXJUsLDG7fB3NK9m3KqaG0ScVQZ8hMVKS3NQi+kHoMZmuNEhvCM8XNWQE82AR92MrDpCMhMLShxwpU+d+/ArF2hF/tYY2ersrgpWrNW6jUawcSGoiJtAyHAIt4EV5S1Qp6UrwcEbC4SSuF3cD0aLSP1GZ/KSBFJLsahydHyJkMp/xn+hr7ICmMq0LqdtdR0Uh9sToQT+3UCIHofjhiwVXVUkKCJqDqKR3rYOYARXmnkA0GIwPhRctQgTYYvmcubUTssc3faV5vrm8sAyowaHDCt3kLvhJjQek/qO0BapqY3SSJBN6xc1uDwND0VyPe2/TaGrzjqPrT7bTVsLmiX/f1oatV8GsW3oRzfNK9nfgAQfWcWjGPZ5Yqmz3ayLUtOZotIIar3240Obli/nUVeK3ev0h7pWK6rEKLP4S/8Dhz4T4fqv8z8CnJ2VWIkTU9Cx1xtJLnsRwXZJnO8tlfiq3/XrcS8SBaNQ8YdLuXsw083HVXCR8addSqUAYu8rn7dQ3o3CnkecxfPGhj+aZ+n/cRHUBuM47Svn4JMFdZF3Fz3iTlWqU7JFNNYAHaXlnLx+/klCgvwIxi2/puoLGSkIpR9hXG1ARQpNwGB5JGRlo4yG5jhlp5FeWDFFKn0O9p2JlRCyhZH9H16WjKFXyt2nlgNDr2J/WrCQ0lzfVYBxIa3r6gRMOcWVw0rTyaFHWTmHr6VhNYFn2gX9Ii4riu5bRPYyjGe6DkGVLuvIRPFaYaRe/UhyaosAv8IWSQDuERE7qijW1a/bLxqmSXf4kwytNbfDjJpf4Pb3srC2m6TfiOS0BcX6VAALH0q97D005Eb4ksc9Oy+HVofpA+cNKrKftrySBsUqnLhT532E9AnShAKBGoIG//+CTWmVvF4aCzMdkaHBAkkaGYl/ugy2bdEq69J+ZqcRW35cRqJdKHdmQhq31oVdUqgcYVTrNCc4rnZc2bgVvjAw0gNCcQHJXRFkz7kzBOW+FoYBnWteUvy9Emf+FIw3gNgjKRaMRbeUB/QHVkccLn/KaTigxlmDBzS6H1gM7YMhXdaPlxw9TCGbt07DmSuupIk9S3GzaZHC4RSpU2gjMcXiyJMY/iZSG88BJvayWWEnFiF72dj9NvNl9zGEJlBv6vpVzVjFO45hVHaACe/M+j8tTfJg4+duW+k1CXDk5gbjW+TBGde0uBc/9wxkw77CFB65g/dc4449HpkoEKmI3DCOtqChcfIuFXNJI6zfH4aXYfyM7OoRDRFOe2MvBZqy8i7W8unAZ6xXXrOKBZ1gIdKOOqjWQ==";
    const result = decryptWithKey(encryptedText.trim(), encryptionKey);
    console.log(result);
    ```

    ```json Payment Result
    {
      "Invoice": {
        "Id": "6389179",
        "Status": "PAID",
        "Reference": "2025060888",
        "CreationDate": "2025-12-24T12:36:57.5330000Z",
        "ExpirationDate": "2025-12-24T14:35:15.0000000Z",
        "ExternalIdentifier": null,
        "UserDefinedField": "",
        "MetaData": null
      },
      "Transaction": {
        "Id": "103610",
        "Status": "SUCCESS",
        "PaymentMethod": "VISA/MASTER",
        "PaymentId": "07076389179322432673",
        "ReferenceId": "535812103610",
        "TrackId": "24-12-2025_3224326",
        "AuthorizationId": "103610",
        "TransactionDate": "2025-12-24T12:37:05.8136549Z",
        "ECI": "02",
        "IP": {
          "Address": "41.35.105.183",
          "Country": "Egypt"
        },
        "Error": {
          "Code": "",
          "Message": ""
        },
        "Card": {
          "NameOnCard": "Hosam",
          "Number": "512345xxxxxx0008",
          "Token": "",
          "PanHash": "b888aa5f23a817883d4d12c74044bab1ae6ee65dc8d6e11515394aba452b273b",
          "ExpiryMonth": "12",
          "ExpiryYear": "34",
          "Brand": "Mastercard",
          "Issuer": "Test Bank",
          "IssuerCountry": "KWT",
          "FundingMethod": "credit"
        }
      },
      "Customer": {
        "Reference": "",
        "Name": "Anonymous",
        "Mobile": "+965",
        "Email": ""
      },
      "Amount": {
        "BaseCurrency": "KWD",
        "ValueInBaseCurrency": "10",
        "ServiceCharge": "0.2",
        "ServiceChargeVAT": "0.03",
        "ReceivableAmount": "9.77",
        "DisplayCurrency": "KWD",
        "ValueInDisplayCurrency": "10",
        "PayCurrency": "KWD",
        "ValueInPayCurrency": "10"
      },
      "Suppliers": []
    }
    ```

    <Image align="center" alt="Complete Payment Mode (Embedded Methods, shouldHandlePaymentUrl = true)" caption="Complete Payment Mode (Embedded Methods, shouldHandlePaymentUrl = true)" src="https://files.readme.io/f5e903c9ea0c3bfd3ab6fa5f75a46f3e3d69749d17768ef9e72c8c0cd85b5191-CP_EM_TRUE.png" width="600px" />

  - Hosted Methods (e.g., KNET):\
    MyFatoorah automatically redirects the customer to the payment page. After the payment is completed, use the `paymentId` from the redirection URL to retrieve the payment status.\
    `https://your-website.com/payment-callback?paymentId=07076127942302114071&Id=07076127942302114071`

    <Image align="center" alt="Complete Payment Mode (Hosted Methods, shouldHandlePaymentUrl = true)" caption="Complete Payment Mode (Hosted Methods, shouldHandlePaymentUrl = true)" src="https://files.readme.io/029832feae333f19d570b495fa98a5a0b0e92802b593f7f0a3e65c82e1abf854-CM_HO_TRUE.png" width="600px" />

- **If shouldHandlePaymentUrl: false:**
  - Embedded Methods (Card/Apple/Google/STC Pay):\
    You must handle the OTP page either by displaying it in an iframe or by redirecting the user to it.

    ```json Callback Response
    {
      "isSuccess": true,
      "paymentType": "CARD",
      "sessionId": "KWT-4f88aa92-94d1-433c-8043-2f7768c1a12a",
      "paymentCompleted": false,
      "card": {
        "brand": "Mastercard",
        "panHash": "b888aa5f23a817883d4d12c74044bab1ae6ee65dc8d6e11515394aba452b273b",
        "token": "",
        "number": "512345xxxxxx0008",
        "nameOnCard": "Hosam",
        "expiryYear": "34",
        "expiryMonth": "12",
        "issuer": "Test Bank",
        "issuerCountry": "KWT",
        "fundingMethod": "credit",
        "productName": "Mastercard Titanium"
      },
      "redirectionUrl": "https://demo.MyFatoorah.com/En/KWT/PayInvoice/MpgsAuthentication?paymentId=07076389193322434173&sessionId=SESSION0002674591675H70711641I9&mfSessionId=4f88aa92-94d1-433c-8043-2f7768c1a12a",
      "paymentId": "07076389193322434173"
    }
    ```

  - Hosted Methods (e.g., KNET):\
    You receive the `redirectionUrl` in the callback, and you must redirect the user to it to complete the payment.

    ```json Callback Response
    {
      "isSuccess": true,
      "paymentType": "HOSTED_PAYMENT",
      "hostedPaymentName": "BENEFIT",
      "sessionId": "KWT-ac4ed8bb-0978-4cd5-883c-843ad4b82c65",
      "paymentCompleted": false,
      "redirectionUrl": "https://demo.MyFatoorah.com/En/KWT/PayInvoice/Checkout?invoiceKey=050712180638919562-fbd66d4f&paymentGatewayId=116"
    }
    ```

  <Image align="center" alt="Complete Payment Mode (shouldHandlePaymentUrl = false)" caption="Complete Payment Mode (shouldHandlePaymentUrl = false)" src="https://files.readme.io/ca62b61e5d1ade1f13c5d3963312065f724654e7f1c46dd360639f2bf621f34e-CP_FALSE.png" width="600px" />

> 📘 OTP Page in an Iframe
>
> To know how to show the OTP page in an iframe, kindly check the following link: <https://docs.myfatoorah.com/docs/otp-page-in-an-iframe/>

## **Mode 2: Collect Details**

This mode is a two-step payment integration approach that provides flexibility for complex pricing scenarios where you need to collect payment information first before processing the actual payment.

### **Step 1: Create Payment Session**

Make a server-side API call to create a new payment session with `PaymentMode: “COLLECT_DETAILS”`\
You need to do this for each payment separately. **SessionId** is valid for only one payment.

**Endpoint:** `POST /v3/sessions` ([Create Session](https://docs.myfatoorah.com/reference/create-session))

```json Request Example
{
  "PaymentMode": "COLLECT_DETAILS",
  "Order": {
    "Amount": 10
  }
}
```

```json Response
{
  "IsSuccess": true,
  "Message": "Created Successfully!",
  "ValidationErrors": null,
  "Data": {
    "SessionId": "KWT-7b540311-6fcd-417d-b3a8-d7166cbbf773",
    "SessionExpiry": "2025-09-29T00:13:14.4074096Z",
    "EncryptionKey": "jWdKKGPFYmVykT6lpUIpKfuqQRKYraienXtLqhwGHRI=",
    "OperationType": "PAY",
    "Order": {
      "Amount": 10.0,
      "Currency": "KWD",
      "ExternalIdentifier": null
    },
    "Customer": {
      "Reference": null,
      "Cards": null
    }
  }
}
```

### **Step 2: Initialize Client-Side Integration**

**Include JavaScript Library:**

```html
// Test Environment
<script src="https://demo.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Kuwait, Bahrain, Jordan, and Oman
<script src="https://portal.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For UAE
<script src="https://ae.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Saudi Arabia
<script src="https://sa.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Qatar
<script src="https://qa.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Egypt
<script src="https://eg.myfatoorah.com/sessions/v1/session.js"></script>
```

**Create Container Element:**

You need to define a div element with a unique id attribute. The Unified Session will be loaded inside this div after passing the div id to the configuration variable.

```html
<div id="embedded-sessions"></div>
```

**Configure and Initialize:**

Now you need to add the configuration variables. Place the following snippet in a new script tag after loading the JavaScript library, and replace the **sessionId** parameter with the "SessionId" you receive from the `POST /v3/sessions` Endpoint.

```javascript
var config = {
  sessionId: "KWT-56956bac-0bbe-437f-bf61-e629bd4aed4d", // Add the "SessionId" you received from POST Session Endpoint.
  callback: payment, // MyFatoorah triggers this callback after the customer completes payment, either by submitting card details, finishing Google Pay / Apple Pay / STC Pay, or choosing any hosted payment method.
  containerId: "embedded-sessions", //Enter the div id you created in previous step.
};

myfatoorah.init(config);

function payment(response) {
  console.log(JSON.stringify(response));
}
```

### **Step 3: Handle Payment Response**

The callback function response depends on the chosen payment method.

```json Embedded Payment Methods
{
  "isSuccess": true,
  "paymentType": "CARD",
  "sessionId": "KWT-56956bac-0bbe-437f-bf61-e629bd4aed4d",
  "paymentCompleted": false,
  "card": {
    "brand": "Mastercard",
    "panHash": "b888aa5f23a817883d4d12c74044bab1ae6ee65dc8d6e11515394aba452b273b",
    "token": "",
    "number": "512345xxxxxx0008",
    "nameOnCard": "Adel",
    "expiryYear": "34",
    "expiryMonth": "12",
    "issuer": "Test Bank",
    "issuerCountry": "KWT",
    "fundingMethod": "credit",
    "productName": "Mastercard Titanium"
  }
}
```

```json Hosted Payment Methods
{
  "isSuccess": true,
  "paymentType": "HOSTED_PAYMENT",
  "hostedPaymentName": "KNET",
  "sessionId": "KWT-7b540311-6fcd-417d-b3a8-d7166cbbf773",
  "paymentCompleted": false
}
```

### **Step 4: Process Payment**

**Make a second API call to process the payment using the same`SessionId`**\
and then redirect the customer to the `PaymentURL` to complete the payment process (OTP for cards or hosted payment page).

Endpoint: `POST /v3/payments` ([Create Payment](https://docs.myfatoorah.com/reference/create-payment))

```json Request Example
{
  "SourceOfFund": {
    "SessionId": "KWT-7b540311-6fcd-417d-b3a8-d7166cbbf773"
  },
  "Order": {
    "Amount": 23 // here you can update the amount of payment
  }
}
```

```json Embedded Methods Response
{
  "IsSuccess": true,
  "Message": "",
  "ValidationErrors": null,
  "Data": {
    "InvoiceId": "6522848",
    "PaymentId": "07076522848332706072",
    "PaymentURL": "https://demo.MyFatoorah.com/En/KWT/PayInvoice/MpgsAuthentication?paymentId=07076522848332706072&sessionId=SESSION0002142880473I8690260J63&mfSessionId=282901aa-1fcb-4832-b181-d14021d87e9f",
    "PaymentCompleted": false,
    "TransactionDetails": null,
    "Card": {
      "Number": "512345xxxxxx0008",
      "ExpiryMonth": "01",
      "ExpiryYear": "39",
      "Brand": "Mastercard",
      "PanType": "Card",
      "Issuer": "Test Bank",
      "PanHash": "b888aa5f23a817883d4d12c74044bab1ae6ee65dc8d6e11515394aba452b273b",
      "Token": "",
      "NameOnCard": "test",
      "IssuerCountry": "KWT",
      "FundingMethod": "credit",
      "ProductName": "Mastercard Titanium",
      "IsValidCard": null,
      "Is3DSVerified": false
    }
  }
}
```

```json Hosted Methods Response
{
  "IsSuccess": true,
  "Message": "",
  "ValidationErrors": null,
  "Data": {
    "InvoiceId": "6522896",
    "PaymentId": null,
    "PaymentURL": "https://demo.MyFatoorah.com/En/KWT/PayInvoice/Checkout?invoiceKey=050754719652289664-ea785323&paymentGatewayId=1121",
    "PaymentCompleted": false,
    "TransactionDetails": null,
    "Card": {
      "Number": "",
      "ExpiryMonth": "",
      "ExpiryYear": "",
      "Brand": "",
      "PanType": "",
      "Issuer": "",
      "PanHash": "",
      "Token": "",
      "NameOnCard": "",
      "IssuerCountry": "",
      "FundingMethod": "",
      "ProductName": "",
      "IsValidCard": null,
      "Is3DSVerified": false
    }
  }
}
```

<Image align="center" alt="Collect Details Mode" caption="Collect Details Mode" src="https://files.readme.io/5afc2cb6c44893e4539bc79b7835b90a47a17f7580f56d3a9c0296e81e266471-CD_MODE.png" width="600px" />

<br />

> 🚧 Note
>
> The following parameters cannot change between POST /v3/sessions and POST /v3/payments:
>
> - OperationType
> - 3ds model

> 📘 Payment Status
>
> Always use [Webhook ](https://docs.myfatoorah.com/edit/webhook) with the [Get Payment Details](https://docs.myfatoorah.com/reference/get-payment-details) endpoint to confirm the final payment status.

> 📘 Old Integration (V2)
>
> In case you are using the integration for v2, you can find the documentation here:
>
> - [Introduction](https://docs.myfatoorah.com/docs/embedded-payment)
> - [Embedded Payment](https://docs.myfatoorah.com/docs/embedded-integration-steps)
> - [Customizing Embedded Payment](https://docs.myfatoorah.com/docs/unified-session-customization)
> - [Tokenized Embedded Payments](https://docs.myfatoorah.com/docs/tokenized-embedded)
> - [Sample Code](https://docs.myfatoorah.com/docs/unified-sample-code)

> 📘 Native Integration
>
> If you need to integrate **Wallets** using Native Integration, please refer to the following guide: [Native Wallet Integration](https://docs.myfatoorah.com/docs/v3-native-wallets)

---

# Customizing Embedded Payment

## Introduction

You can customize the look and feel of the Embedded Payment and utilize different features available for different payment methods. This gives you full control over how each payment method appears and behaves inside your embedded checkout flow.

## General Customizations

<br />

| Parameter              | Type                                | Description                                                                                              |
| :--------------------- | :---------------------------------- | :------------------------------------------------------------------------------------------------------- |
| subscribedEvents       | Array of Strings of the event names | The names of the events to which you want to subscribe                                                   |
| eventListener          | Function                            | A function that describes the action you want to take once an event is received to handle it accordingly |
| shouldHandlePaymentUrl | Bool                                | Controls the payment flow for embedded payment methods                                                   |

### Event Types

| Event Name              | Description                                                                                                                                                                                                     | Example                                                                                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VIEW_READY              | This event is received once the embedded view is ready to be rendered on the page. You can hide it to display your loader until you get the event that the view is ready.                                       | `{"name": "VIEW_READY", "id": 1, "paymentMethodName": "ALL", "data": {}}`                                                                                                                                                                     |
| CARD_IDENTIFIED         | This event is triggered once the user enters the first 10 digits of his card and the event includes the card information of the customer. **This needs to be enabled for your account by the account manager.** | `{"name": "CARD_IDENTIFIED", "id": 4, "paymentMethodName": "CARD", "data": {"cardBin": "512345", "cardBrand": "Mastercard", "issuer": "Test Bank", "issuerCountry": "KWT", "fundingMethod": "credit", "productName": "Mastercard Titanium"}}` |
| PAYMENT_STARTED         | This event is triggered once the customer submits his card information or selects a specific payment method to make the payment.                                                                                | `{"name": "PAYMENT_STARTED", "id": 2, "paymentMethodName": "CARD", "data": {}}`                                                                                                                                                               |
| PAYMENT_COMPLETED       | This event is triggered when the customer completes the payment flow using the card. It will get triggered only in the case of shouldHandlePaymentUrl set to true.                                              | `{"name": "PAYMENT_COMPLETED", "id": 3, "paymentMethodName": "CARD", "data": {}}`                                                                                                                                                             |
| SESSION_STARTED         | This event is triggered when the user opens Apple Pay payment sheet after clicking on the button.                                                                                                               | `{"name": "SESSION_STARTED", "id":5, "paymentMethodName": "APPLE_PAY", "data": {}}`                                                                                                                                                           |
| SESSION_CANCELED        | This event is triggered when the user closes Apple Pay payment sheet.                                                                                                                                           | `{"name": "SESSION_CANCELED", "id":6, "paymentMethodName": "APPLE_PAY", "data": {}}`                                                                                                                                                          |
| 3DS_CHALLENGE_INITIATED | This event is triggered when the OTP page is displayed to the user. It will get triggered only in the case of shouldHandlePaymentUrl set to true.                                                               | `{"name": "3DS_CHALLENGE_INITIATED", "id": 7, "paymentMethodName": "CARD", "data": {}}`                                                                                                                                                       |
| OTP_REQUESTED           | This event will be triggered only in STC Pay when the customer receives the OTP.                                                                                                                                | `{"name": "OTP_REQUESTED", "id": 8, "paymentMethodName": "STC_PAY", "data": {"mobileNumber": "0548220713"}}`                                                                                                                                  |

## Customizations per Payment Method

You can customize each payment method individually, which will not apply these changes to the rest of the payment methods. You can customize each payment method using the same flow clarified in the sample code below.

```javascript Config
var config = {
  sessionId: sessionId,
  callback: payment,
  containerId: "unified-session",
  settings: {
    loader: {
      //This hides the loader that appears after the user submits his card information
      display: "none",
    },
    card: {
      // Add your customization for card here
    },
    applePay: {
      // Add your customization for Apple Pay here
    },
    googlePay: {
      // Add your customization for Google Pay here
    },
    stcPay: {
      // Add your customization for STC Pay here
    },
  },
};
```

---

## Card Customizations

| Parameter                | Type    | Description                                                                                                                                         |
| :----------------------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| language                 | String  | This specifies the language in which Card text is displayed. This will override the one in the general config when the session created. _(English)_ |
| style                    | Object  | You can manage the look and feel of the card from this object.                                                                                      |
| style.hideCardIcons      | Boolean | You can manage if you want to display the available card brands in the Card form or not. _(False)_                                                  |
| style.showCardholderName | Boolean | Enables or disables the Cardholder Name input field in the card payment form. _(True)_                                                              |
| style.cardHeight         | String  | The height of the card form when the fields for card entry are displayed                                                                            |
| style.tokenHeight        | String  | The height of the card form when the saved cards are displayed                                                                                      |
| style.input              | Object  | This customizes the text entered by the customer, the form borders, and the placeholders in the card form.                                          |
| style.text               | Object  | This customizes the text written on the card form for managing saving cards.                                                                        |
| style.label              | Object  | This customizes the labels that could be added over the fields of the card form.                                                                    |
| style.error              | Object  | This customizes the look of the fields when there is an error in the input of the customer.                                                         |
| style.button             | Object  | You can manage the button on which the customer clicks on after he fills in the card information. Please check below for more information           |
| style.separator          | Object  | This enables you to customize the separator displayed on the Embedded Payment before the Card form. Please check below for more information.        |

### style.button:

Customize the look and feel of the button. There are two scenarios that you can rely on to enable your customer to click on a button to complete the payment after filling in the card information:

1. **Using MyFatoorah's default behavior:**
   In this case, MyFatoorah manages all the functionalities of the button and returns to you the payment data in the callback function.

```javascript
button: {
    useCustomButton: false,
    textContent: "Pay",
    fontSize: "16px",
    fontFamily: "Times",
    color: "white",
    backgroundColor: "black",
    height: "30px",
    borderRadius: "8px",
    width: "70%",
    margin: "0 auto",
    cursor: "pointer"
},
```

2. **Using your button with its functionalities**\
   In this case, you will be creating the button on your side and will manage its functionalities fully. It is mandatory to call the function **myfatoorah.submitCardPayment()** when the customer clicks on the payment button.

```javascript style.button
//Create the button on which the customer will click after entering the card information
//Define the function to call after the customer clicks on the button
<button
  onclick="customSubmit()"
  style="display: block; margin: 0 auto; width: 400px; height: 30px; cursor: pointer; background-color: #008CBA; border: none; color: white; font-size: 16px; border-radius: 8px;"
>
  Pay Now
</button>;

// =================================
// Don't use MyFatoorah button
var button = {
  useCustomButton: true,
};

// =================================
// Define the function customSubmit to handle the payment process
function customSubmit() {
  // Here you can add the steps you want to do when the button is clicked.
  myfatoorah.submitCardPayment(); // This function is mandatory
}
```

### myfatoorah.submitCardPayment()

This function can accept an object as an argument. The argument enables you to control the payment flow. The object can currently have two properties, currency and skipTokenSave.

```javascript
var options = {
  currency: "USD",
  skipTokenSave: true,
};

myfatoorah.submitCardPayment(options);
```

### Validate card inputs

This function enables you to validate the input of the customer in the card form before calling MyFatoorah function to submit the card information. This also enables you to let your customers know which input field is incorrect by a customized error message on your end.

```javascript
function customSubmit() {
  myfatoorah
    .validateCardInputs()
    .then((result) => {
      console.log("success" + JSON.stringify(result)); // "Data fetched successfully!"
      myfatoorah.submitCardPayment(); //It is mandatory to call this function
    })
    .catch((error) => {
      console.log("failed" + JSON.stringify(error)); // "Error fetching data."
    });
}
```

### style.separator

From this object, you can customize the display of the separator before the Card to make it fit your website.

```javascript Separator
separator: {
    useCustomSeparator: false,
    textContent: "Pay with Card",
    fontSize: "14px",
    color: "#4daee0",
    fontFamily: "sans-serif",
    textSpacing: "5px",
    lineStyle: "dashed",
    lineColor: "black",
    lineThickness: "2px"
}
```

### Card Sample Code

Below is a sample code clarifying the customizations of the card:

```javascript card customizations
var config = {
  sessionId: sessionId,
  callback: payment,
  containerId: "unified-session",
  subscribedEvents: [
    "VIEW_READY",
    "CARD_IDENTIFIED",
    "PAYMENT_STARTED",
    "PAYMENT_COMPLETED",
    "SESSION_STARTED",
    "SESSION_CANCELED",
    "3DS_CHALLENGE_INITIATED",
    "OTP_REQUESTED",
  ],
  eventListener: eventHandler,
  shouldHandlePaymentUrl: true,
  settings: {
    card: {
      language: "ar",
      style: {
        showCardholderName: true,
        hideCardIcons: true,
        cardHeight: "200px",
        tokenHeight: "230px",
        input: {
          color: "black",
          fontSize: "15px",
          fontFamily: "courier",
          inputHeight: "32px",
          inputMargin: "3px",
          borderColor: "black",
          backgroundColor: "green",
          borderWidth: "1px",
          borderRadius: "30px",
          outerRadius: "10px",
          //boxShadow: "0 0 10px 5px purple, 0 0 15px 10px lightblue",
          placeHolder: {
            color: "#DCEBFF",
            holderName: "Name On Card",
            cardNumber: "Number",
            expiryDate: "MM/YY",
            securityCode: "CVV",
          },
        },
        text: {
          saveCard: "Save card info for future payments",
          addCard: "Use another Card!",
          deleteAlert: {
            title: "Delete",
            message: "Are you sure?",
            confirm: "YES",
            cancel: "NO",
          },
        },
        label: {
          display: true,
          color: "black",
          fontSize: "13px",
          fontWeight: "bold",
          fontFamily: "Times",
          text: {
            holderName: "Card Holder Name",
            cardNumber: "Card Number",
            expiryDate: "Expiry Date",
            securityCode: "Security Code",
          },
        },
        error: {
          borderColor: "red",
          borderRadius: "8px",
          //boxShadow: "0 0 10px 5px purple, 0 0 15px 10px lightblue",
        },
        button: {
          textContent: "Pay",
          fontSize: "16px",
          fontFamily: "Times",
          color: "white",
          backgroundColor: "#4daee0",
          height: "30px",
          borderRadius: "8px",
          width: "70%",
          margin: "0 auto",
          cursor: "pointer",
        },
        separator: {
          useCustomSeparator: false,
          textContent: "Enter your card",
          fontSize: "20px",
          color: "#4daee0",
          fontFamily: "sans-serif",
          textSpacing: "2px",
          lineStyle: "dashed",
          lineColor: "black",
          lineThickness: "3px",
        },
      },
    },
  },
};
```

---

## Apple Pay Customizations

| **Parameter**                 | **Type** | **Description**                                                                                                                                                                                                             |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| requiredBillingContactFields  | Array    | This will force the customer to enter the fields that you pass in the array in his Apple Pay wallet to be able to proceed with the payment. The information that he enters is then returned to you in the callback function |
| requiredShippingContactFields | Array    | This will force the customer to enter the fields that you pass in the array in his Apple Pay wallet to be able to proceed with the payment. The information that he enters is then returned to you in the callback function |
| language                      | String   | This specifies the language in which Apple Pay text is displayed. This will override the one in the general config when the session created.                                                                                |
| style                         | Object   | You can manage the look and feel of the Apple Pay button from here.                                                                                                                                                         |

### requiredShippingContactFields

If you're using this field, your customer cannot pay via Apple Pay unless he has entered his Shipping Information. You can retrieve the shipping information that the customer has in his Apple Pay wallet from the shippingContact object in the response of the callback function.

```javascript Config
requiredShippingContactFields: ["postalAddress", "name", "phone", "email"],//You can remove what you don't need
```

```javascript shippingContact
"shippingContact": {
        "addressLines": ["ElIkhlas", "13"],
        "administrativeArea": "",
        "country": "Saudi Arabia",
        "countryCode": "SA",
        "emailAddress": "test@gmail.com",
        "familyName": "MyFatoorah",
        "givenName": "Tech",
        "locality": "Haram",
        "phoneNumber": "00201111111111",
        "phoneticFamilyName": "",
        "phoneticGivenName": "",
        "postalCode": "33651",
        "subAdministrativeArea": "",
        "subLocality": "Mariotia"
    }
```

### requiredBillingContactFields

If you're using this field, your customer cannot pay via Apple Pay unless he has entered his Billing Information. You can retrieve the billing information that the customer has in his Apple Pay wallet from the billingContact object in the response to the callback function

```javascript Config
requiredBillingContactFields: ["postalAddress", "name", "phone"],//You can remove what you don't need
```

```javascript billingContact
"billingContact": {
        "addressLines": ["ElIkhlas", "13"],
        "administrativeArea": "",
        "country": "Saudi Arabia",
        "countryCode": "SA",
        "familyName": "MyFatoorah",
        "givenName": "Tech",
        "locality": "Riyadh",
        "phoneticFamilyName": "",
        "phoneticGivenName": "",
        "postalCode": "33651",
        "subAdministrativeArea": "",
        "subLocality": "As Sulimaniyah"
    }
```

### style

This enables you to customize the display of the Apple Pay button.

```javascript Config
style: {
    frameHeight: "40px",
    frameWidth: "100%",
    button: {
        height: "40px",
        type: "checkout", //["plain", "buy", "pay", "checkout", "continue", "book", "donate", "subscribe", "reload", "add", "topup", "order", "rent", "support", "contribute", "setup", "tip"]
        borderRadius: "20px",
    }
},
```

### Apple Pay Sample Code

Below is a sample code clarifying the customizations of Apple Pay

```javascript Apple Pay Customization
var config = {
  sessionId: sessionId,
  callback: payment,
  containerId: "unified-session",
  shouldHandlePaymentUrl: true,
  settings: {
    applePay: {
      //language: "ar",
      style: {
        frameHeight: "40px",
        frameWidth: "100%",
        button: {
          height: "40px",
          type: "buy", //["plain", "buy", "pay", "checkout", "continue", "book", "donate", "subscribe", "reload", "add", "topup", "order", "rent", "support", "contribute", "setup", "tip"]
          borderRadius: "20px",
        },
      },
      requiredShippingContactFields: ["postalAddress", "name", "phone", "email"],
      requiredBillingContactFields: ["postalAddress", "name", "phone"],
    },
  },
};
```

---

## Google Pay Customizations

| **Parameter** | **Type** | **Description**                                                                                                                               |
| :------------ | :------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| language      | String   | This specifies the language in which Google Pay text is displayed. This will override the one in the general config when the session created. |
| style         | Object   | You can manage the look and feel of the Google Pay button from here.                                                                          |

### **style**

This enables you to customize the display of the Google Pay button

```javascript style
style: {
    frameHeight: "55px",
    frameWidth: "100%",
    button: {
        height: "40px",
        type: "pay", // Accepted texts: ["book", "buy", "checkout", "donate", "order", "pay", "plain", "subscribe"]
        borderRadius: "8px",
        color: "black" //["white", "black"]
    }
}
```

### **Google Pay Sample Code**

Below is a sample code clarifying the customizations of Google Pay

```javascript Google Pay Customization
var config = {
  sessionId: "KWT-e33b7416-8e3c-4d6e-a967-28c09d33e888",
  callback: payment,
  containerId: "unified-session",
  shouldHandlePaymentUrl: true,
  settings: {
    googlePay: {
      //language: "ar",
      //callback: paymentGP,
      style: {
        frameHeight: "55px",
        frameWidth: "100%",
        button: {
          height: "40px",
          type: "pay", // Accepted texts: ["book", "buy", "checkout", "donate", "order", "pay", "plain", "subscribe"]
          borderRadius: "8px",
          color: "black",
        },
      },
    },
  },
};
```

---

## STC Pay Customizations

| **Parameter** | **Type** | **Description**                                                                                                                     |
| :------------ | :------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| mobileNumber  | string   | You can add here a mobile number to be displayed by default and the customer can change it if he wants to use a different currency. |
| style         | object   | This enables you to customize the look and feel for STC Pay                                                                         |

### **mobileNumber:**

The value of the mobile that you add here will be auto-filled in STC Pay by default. The customer can change or use the same mobile number that you have filled in here.

### **style**

You can use these parameters to customize the view of STC Pay.

```javascript style
style: {
    frameHeight: "40px",
    frameWidth: "100%",
    input: {
        color: "#582490",
        fontSize: "14px",
        fontFamily: "'roboto', sans-serif",
        inputHeight: "40px",
        borderColor: "black",
        borderWidth: "2px",
        borderRadius: "9px",
        placeHolder: {
            mobileNumber: "05________",
            otpValue: "Enter OTP!"
        }
    },
    button: {
        borderRadius: "9px",
        height: "40px"
    }
}
```

### **STC Pay Sample Code**

Below is a sample code clarifying the customizations of STC Pay

```javascript STC Pay Customization
var config = {
  sessionId: sessionId,
  callback: payment,
  containerId: "unified-session",
  shouldHandlePaymentUrl: true,
  settings: {
    stcPay: {
      mobileNumber: "0548220713",
      // language: "en",
      style: {
        frameHeight: "40px",
        frameWidth: "100%",
        input: {
          color: "#582490",
          fontSize: "14px",
          fontFamily: "'roboto', sans-serif",
          inputHeight: "40px",
          borderColor: "black",
          borderWidth: "2px",
          borderRadius: "9px",
          placeHolder: {
            mobileNumber: "05________",
            otpValue: "Enter OTP!",
          },
        },
        button: {
          borderRadius: "9px",
          height: "40px",
        },
      },
    },
  },
};
```

## <br />

# Tokenized Embedded Payments

## **Introduction**

Explore an extra layer of functionality with our optional feature designed to securely store your customers' cards. With this feature, you receive a unique token for each card, providing an added layer of convenience for your users. For each customer, MyFatoorah effortlessly retrieves the masked card number along with the corresponding token for all saved cards. Now, you can seamlessly showcase saved cards separate from MyFatoorah's Embedded Integration. Enhance the user experience by displaying masked card numbers while ensuring secure payment transactions through the associated card tokens.

> ❗️ Availability
>
> In order to enable this feature, you need to contact your [account manager](https://www.myfatoorah.com/en/contact-us/).

> 👍 Tokenized Embedded Payments
>
> You do not need to be PCI DSS certified to use this feature.

## How it works:

### How to save the token?

You need to call `POST /v3/sessions` Endpoint to get the **SessionId** to be used in your configuration to display the Card View. You need to do this for each payment separately. **SessionId** is valid for only one payment.\
In the request to initiate a session to save the token for the card that the customer will enter, you need to pass the value of SaveToken to be **true** and a unique Reference for each customer. If you send the value of SaveToken as false or don't send it at all, it will work as in the normal flow of the embedded payment without tokenizing the card.

**After the customer submits his card information, we will return to you the token for the card in the callback function.**

**Endpoint:** `POST /v3/sessions`

```json Request Example
{
  "PaymentMode": "COMPLETE_PAYMENT",
  "Order": {
    "Amount": 10
  },
  "SaveCardOptions": {
    "SaveToken": true
  },
  "Customer": {
    "Reference": "#1234"
  },
  "IntegrationUrls": {
    "Redirection": "https://your-website.com/payment-callback"
  }
}
```

```json Response
{
  "IsSuccess": true,
  "Message": "Created Successfully!",
  "ValidationErrors": null,
  "Data": {
    "SessionId": "KWT-892bd72a-bb85-4756-b68e-85b46ab8efd6",
    "SessionExpiry": "2025-10-26T16:48:15.9725428Z",
    "EncryptionKey": "4Iy7JAzgjCjdtrhOINSFP5kEp08w/6s1QWdVMhR+IH0=",
    "OperationType": "PAY",
    "Order": {
      "Amount": 10.0,
      "Currency": "KWD",
      "ExternalIdentifier": null
    },
    "Customer": {
      "Reference": "#1234",
      "Cards": []
    }
  }
}
```

> 📘 Customer Reference
>
> It is mandatory to specify a Customer.Reference when the value of SaveToken is true. Each customer should have a unique Reference.

The next steps for the first payments will be the same as in [Embedded Integration](https://docs.myfatoorah.com/docs/embedded-payment-v3).

---

## How to make payments using the token?

### **1- Call** POST /v3/sessions **using the same Customer Reference**

Initiate a session by calling the POST /v3/sessions API with the same **Customer Reference and make sure to set RetrieveSavedTokens: "true"**. The response will include a unique SessionId and tokenized cards associated with that Customer **Reference**. Each card's details, such as the **Masked Card**, **Token**, and **Card Brand**, will be provided.

```json Request Example
{
  "PaymentMode": "COMPLETE_PAYMENT",
  "Order": {
    "Amount": 10
  },
  "SaveCardOptions": {
    "SaveToken": true,
    "RetrieveSavedTokens": true
  },
  "Customer": {
    "Reference": "#1234"
  },
  "IntegrationUrls": {
    "Redirection": "https://your-website.com/payment-callback"
  }
}
```

```json Response
{
  "IsSuccess": true,
  "Message": "Created Successfully!",
  "ValidationErrors": null,
  "Data": {
    "SessionId": "KWT-76a635c8-066e-4d41-ae3e-5d530c55784b",
    "SessionExpiry": "2025-10-26T16:50:49.3473139Z",
    "EncryptionKey": "w1jxizxjHRk5fs0toaqELL++N2P1JBn+lFY5r2FOgD0=",
    "OperationType": "PAY",
    "Order": {
      "Amount": 10.0,
      "Currency": "KWD",
      "ExternalIdentifier": null
    },
    "Customer": {
      "Reference": "#1234",
      "Cards": [
        {
          "Is3DSVerified": true,
          "Token": "TKN-0fb06aac-634d-418a-bf78-953202b67b53",
          "Number": "512345xxxxxx0008",
          "Brand": "Master",
          "TokenType": "CARD"
        }
      ]
    }
  }
}
```

### **2- Display the Card View and the Tokenized Cards**

Utilize the masked card numbers from the response to present the saved cards to your customers. Enable them to choose from the list of saved cards. Once a customer selects a card, prompt them to enter the CVV for the chosen card.

### **3- Collect Customer's CVV Using MyFatoorah Component**

This step involves utilizing the MyFatoorah JavaScript component to securely collect the customer's CVV. By leveraging this component, the CVV is managed directly by MyFatoorah, ensuring secure handling and eliminating the need for you application to be PCI DSS certified for this process.

#### **Steps:**

#### **1- Include the JavaScript library:**

Choose the test or the live library according to your working environment. Please note that this is the same JavaScript for the embedded payment.

```javascript
// Test Environment
<script src="https://demo.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Kuwait, Bahrain, Jordan, and Oman
<script src="https://portal.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For UAE
<script src="https://ae.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Saudi Arabia
<script src="https://sa.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Qatar
<script src="https://qa.myfatoorah.com/sessions/v1/session.js"></script>

// Live Environment For Egypt
<script src="https://eg.myfatoorah.com/sessions/v1/session.js"></script>
```

#### **2- Define a div element**

You need to define a div element with a unique id attribute. The CVV component will be displayed inside this div after passing the div id to the configuration variable.

```html
<div id="cvv-component"></div>
```

#### **3- Configure the CVV Component**

Create a configuration variable for the CVV component and include in it the sessionId, countryCode, containerId, and **callback**

```javascript
var configCvvView = {
  sessionId: "KWT-ca809438-7de1-463a-b5ad-7b273c845252",
  containerId: "cvv-component",
  shouldHandlePaymentUrl: true,
  callback: proceedCvv,
  style: {
    direction: "ltr",
    cardHeight: 90,
    error: {
      borderColor: "red",
      borderRadius: "0px",
      boxShadow: "1px",
    },
    input: {
      color: "black",
      fontSize: "13px",
      fontFamily: "Sofia",
      inputHeight: "30px",
      inputMargin: "-1px",
      borderColor: "c7c7c7",
      borderWidth: "1px",
      borderRadius: "0px",
      boxShadow: "",
      //placeHolder: "security code(cvv)"
    },
    label: {
      display: true,
      color: "green",
      fontSize: "25px",
      fontWeight: "normal",
      fontFamily: "Sofia",
      text: "cvv",
    },
  },
};

myfatoorah.initCvv(configCvvView);

function proceedCvv(response) {
  console.log("proceedCvv");
  if (response.isSuccess) {
    console.log("response >> " + JSON.stringify(response));
    alert(JSON.stringify(response));
  } else {
    alert(JSON.stringify(response));
    console.log(response);
  }
}
```

This will make the CVV component load so that the customer can enter their CVV in the view.

#### **4- Handle the submit button**

After that, you need to handle your submit button to call **myfatoorah.submitCvv()** using the token of the card that the customer chose to pay with.

```html
<button onclick="submitCvv()">Submit CVV</button>

<script>
  function submitCvv() {
    myfatoorah.submitCvv("TKN-0fb06aac-634d-418a-bf78-953202b67b53");
    //Pass the token of the card the customer chose to pay with.
  }
</script>
```

### 4- Handle Payment Response

After the customer enters their CVV and the payment is submitted using myfatoorah.submitCvv(), you will receive a callback response in the callback function. The content of this response depends on the PaymentMode value you passed when initiating the session via the `POST /v3/sessions` API.

#### Mode 1: PaymentMode = COMPLETE_PAYMENT

In this mode, MyFatoorah handles the OTP page. After that, you will receive `paymentCompleted: true` (This does not indicate the payment status, only that the payment flow was completed successfully). To retrieve the actual payment status, use the `paymentData` received in the callback function along with the `EncryptionKey` obtained from the POST session endpoint to decrypt the response and determine the final payment status.

```json Callback Response
{
  "isSuccess": true,
  "sessionId": "KWT-ce7d4888-4797-4123-9c30-0ed41d73a531",
  "paymentCompleted": true,
  "paymentData": "RKMzF47Jm2+LTETqjVXH7a6sWw06UfZ68106udI7VVr8LJ4G0bUfw+JvVU4uhFmn2BEAmtEy9azgXii4p9xcItRLhoV0KsrXLXNKl6GoRkn4jQm8/9K7eSwcIKdrV+Emw2nrjvro8tWzAOXbBLPXfy9PfmPRmFf7zRLPt1WZxO8wsRiaw8K3JmAeqlm6JRmC02m4FCZxmafCK4AzCri4XUxBYma7Uru4flX41KKwa9qZOkiigw5jY+gDxzBB4NxeLTdKhKaNbK7eTufy34ksRQboDACOGV/5GBshSnPTZf+q1tz3qv5wDFJwkly0s6lsq5bMi2MgNdSkjb1d+uiABV3wT0jhvnVQypXorV+JbYPBuBo2h/10KRUfQ2j4uHQ5vhdHVCpv4bGUCUY0VRAU8n7NkjTadPrbmsmI+qDQNCY82XhfB6GCyxC+4QIjDXgTls+Sqffp1PTDmKSOiJ/SKpIO6zGc90ZWjAy4AgneXOU7NaH4FbUuh7Z2y9wuKjfBEktobkOKB8OoCRe9RzXr4wjhrEoTWKfzSw5plO4jQIpkUyijBLgZhexL1quSPN6yw85fo3ZS9nvOiEzeyrQXxcs/FUgjx6tELedKQSFQsBIRkuyWtpqaJKgGWVJltoYeHl6lhwjKygyzpNGsk0HOd3OOvFyiW9k5yQjuskHXia/+kTwel5z41To/JNAz02bdu2sfVaEJMO87z0Scklcv/L+W0YlWXFdF6ZGv5hfLHRIEDxR5mmyZagtimMXL5iFYeKzajiCUcUjg3HIRFnZrNfuUC2FODHKTR+n3iT7NOv5iddzJXn11qMMuD1UQGpceO/rSyPClUvLE6NiNrxcXKxry4IQ4L+MlP2XDZzye+h4CrKEwmjWVFEMySOldgR5+/M8Wx39ELiapkKBUdrifrOZpLwD4D1FugK5nDzm01eOAhaJY/DawXlvWSPaLpgudY3L9Zltx4VdYUbXcqOSGgNoNDW+d8KVU2nrIpUf6bnmBHyyczkp8JjFxIE1PQi0SfwS41Pca9CAJO7UQkwh07frGPJaFWXs6T2Kjyc6YUGfWmaC+giu9Rz5DOC3S/AYf027KU2bIO4ySZs9hDxfiegCBMrv82uUZ3PulywqVfSpr1Wb3c95HHEcAdoyJlA5k0VxqEpoRJMiGTatRxjoqAG9vEYqINeuxm66kinA9SEC/dDK2knLE/SXa34UGT5esljPnTj0J7pnmizy4QfgBVQiJgJ9Is63lguIFdJSL4VnTepd7QDscIMvDHls9dToa3ehULT8wVaqgu7HF31OUoecdA7LsRl27XA0hVGzjZNHc39aGswXpjjycLjhC4YlAfTeONN8aBfWafxQXzT5QS+sNs7T1Op8FYmh9a0fg6Ac8mPzrFW0wfS8/nGFP/Yr/mXuFxkGVD/4vLUDZvfhFV6uEubmSPt6hs2qrngASGUXSY36wlW7YZWmvabpvKtVsaCk6iAs2Dl19JrAnN+IApNJt4P9k89VZEwjSUT9lRt7yWW5qBhfsTZdFhaHLOo342YoxT9MVxf+uCp2iPqBKvA==",
  "paymentType": "CARD",
  "redirectionUrl": "https://your-website.com/payment-callback?paymentId=07076252374312536672&Id=07076252374312536672"
}
```

**Next Step: Decrypt Payment Data**\
To get the **final payment result**, decrypt the `paymentData` using the `EncryptionKey` from the session creation response.\
You can use the sample decryption code provided here: [Embedded Payment](https://docs.myfatoorah.com/docs/embedded-payment-v3#step-3-handle-payment-response)

#### **Case 2: PaymentMode = COLLECT_DETAILS**

In this mode, the first callback returns the card details, but the payment is **not yet completed**.\
You will need to make another API call to **process the payment** using the same `SessionId`.

```json Callback Response
{
  "isSuccess": true,
  "paymentType": "CVV",
  "sessionId": "KWT-f2589d21-11fb-4b91-8b7a-4d3866837645",
  "paymentCompleted": false,
  "card": {
    "brand": "Mastercard",
    "panHash": "b888aa5f23a817883d4d12c74044bab1ae6ee65dc8d6e11515394aba452b273b",
    "token": "TKN-aa7e19a1-eba6-4896-91a2-ccd35159c4b3",
    "number": "512345xxxxxx0008",
    "nameOnCard": "das",
    "expiryYear": "36",
    "expiryMonth": "12",
    "issuer": "Test Bank",
    "issuerCountry": "KWT",
    "fundingMethod": "credit",
    "productName": "Mastercard Titanium"
  }
}
```

**Next Step: Process the Payment**\
Use the `SessionId` from the response to make a payment request through the following API:\
**Endpoint:** `POST /v3/payments`

```json Request Example
{
  "SourceOfFund": {
    "SessionId": "KWT-f2589d21-11fb-4b91-8b7a-4d3866837645"
  },
  "Order": {
    "Amount": 23
  }
}
```

```json Response
{
  "IsSuccess": true,
  "Message": "",
  "ValidationErrors": null,
  "Data": {
    "InvoiceId": "6522912",
    "PaymentId": "07076522912332712772",
    "PaymentURL": "https://demo.MyFatoorah.com/En/KWT/PayInvoice/MFAuthentication?gateway=CS&paymentId=07076522912332712772&gatewayKey=eyJraWQiOiIwOHlGQUY1V2xNdzlUTEZ3ZGp1WE5xTXZoTWZ3OVgzVyIsImFsZyI6IlJTMjU2In0.eyJpc3MiOiJGbGV4LzA4IiwiZXhwIjoxNzcxMjU4NzI4LCJ0eXBlIjoiYXBpLTAuMS4wIiwiaWF0IjoxNzcxMjU3ODI4LCJqdGkiOiIxRTNYWlpOV1U5Rks2NFlTMFZaOVpLUDlWRjhTTk1VUjlQSExBNjdIU1pLMFY1OFFBU0pCNjk5MzQzNjhCREMwIiwiY29udGVudCI6eyJwYXltZW50SW5mb3JtYXRpb24iOnsiY2FyZCI6eyJleHBpcmF0aW9uWWVhciI6eyJ2YWx1ZSI6IjIwMzkifSwibnVtYmVyIjp7Im1hc2tlZFZhbHVlIjoiWFhYWFhYWFhYWFhYMDAwOCIsImJpbiI6IjUxMjM0NSJ9LCJzZWN1cml0eUNvZGUiOnt9LCJleHBpcmF0aW9uTW9udGgiOnsidmFsdWUiOiIwMSJ9LCJ0eXBlIjp7InZhbHVlIjoiMDAyIn19fX19.ZYoiCU_U-KBWV-IsKrwQrJx-X8pk5xOHnB3o9apK0x_3jgOEEadWghbRfhF-TMGaOjU_6wFjRYDtffdZeNjNzgyhTj8Z9SH_PZ9V061yYnuzHo22k0CgWm4gTrGCkJtUDHgnzPdE8D6pfwZVI4r595vhJV8_sYOmunlGwU8a-y432wZheBdbofNLjILeDH0av9gAKHAQPLGhq1cnFoc7JKdFQMPq5SsfM0JrYxQMFfVs8X9qZ70TmbhQHRmK-Ba7A6RPVESOf463nZneF1ek4lyHAwLybdKohroBaCYCGr9ZIInLWP21g99JM07lndd_i8WJUR2gHUoayPB9xlxm7w&mfSessionId=f2589d21-11fb-4b91-8b7a-4d3866837645",
    "PaymentCompleted": false,
    "TransactionDetails": null,
    "Card": {
      "Number": "512345xxxxxx0008",
      "ExpiryMonth": "01",
      "ExpiryYear": "39",
      "Brand": "Mastercard",
      "PanType": "Card",
      "Issuer": "Test Bank",
      "PanHash": "b888aa5f23a817883d4d12c74044bab1ae6ee65dc8d6e11515394aba452b273b",
      "Token": "TKN-aa7e19a1-eba6-4896-91a2-ccd35159c4b3",
      "NameOnCard": "Test Card",
      "IssuerCountry": "KWT",
      "FundingMethod": "credit",
      "ProductName": "Mastercard Titanium",
      "IsValidCard": null,
      "Is3DSVerified": true
    }
  }
}
```

Finally, redirect the customer to the `PaymentURL` to complete the payment process.

> 📘 Note
>
> If you are using COLLECT_DETAILS mode, the card information will be saved against the Customer.Reference in the POST /v3/sessions API.

---

# Sample Code

Embedded Payment Sample Code

This sample code is a complete example of a payment page that uses the MyFatoorah embedded payment.

```html Embedded Payment
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Embedded Payment</title>
    <script src="https://demo.myfatoorah.com/sessions/v1/session.js"></script>
  </head>

  <body style="background-color: white">
    <div style="width: 400px; margin: auto">
      <div id="unified-session"></div>
    </div>

    <script>
      var config = {
        sessionId: "KWT-226c96d3-b243-4f54-aa38-727c1659ec94", //Add the "SessionId" you received from POST Session Endpoint.
        callback: payment, // MyFatoorah calls the callback function after the customer fills in the card and clicks pay or when the customer finishes the steps with GooglePay, STC Pay and Apple Pay or when the customer choose one of hosted payment methods.
        containerId: "unified-session", //Enter the div id you created in previous step.
        shouldHandlePaymentUrl: true, //default is true, if you want to handle OTP page url by yourself (in case the payment supported embedded) or need to redirect customer to hosted page when choose hosted payment method, set it to false.
        eventListener: eventHandler,
        subscribedEvents: [
          "VIEW_READY",
          "CARD_IDENTIFIED",
          "PAYMENT_STARTED",
          "PAYMENT_COMPLETED",
          "SESSION_STARTED",
          "SESSION_CANCELED",
          "3DS_CHALLENGE_INITIATED",
          "OTP_REQUESTED",
        ],
        settings: {
          loader: {
            display: "none",
          },
          // applePay: {
          //   language: "ar",
          //   style: {
          //     frameHeight: "10px",
          //     frameWidth: "100%",
          //     button: {
          //       height: "80px",
          //       type: "subscribe", //["plain", "buy", "pay", "checkout", "continue", "book", "donate", "subscribe", "reload", "add", "topup", "order", "rent", "support", "contribute", "setup", "tip"]
          //       borderRadius: "10px",
          //     },
          //   },
          //   requiredShippingContactFields: [
          //     "postalAddress",
          //     "name",
          //     "phone",
          //     "email",
          //   ],
          //   requiredBillingContactFields: ["postalAddress", "name", "phone"],
          // },
          // googlePay: {
          //   language: "ar",
          //   style: {
          //     frameHeight: "70px",
          //     frameWidth: "100%",
          //     button: {
          //       height: "40px",
          //       type: "book", //Accepted texts ["book", "buy", "checkout", "donate", "order", "pay", "plain", "subscribe"]
          //       borderRadius: "10px",
          //       color: "black", //Accepted colors ["black", "white"]
          //     },
          //   },
          // },
          // card: {
          //   language: "en",
          //   style: {
          //     showCardholderName: true,
          //     hideCardIcons: true,
          //     cardHeight: "180px",
          //     tokenHeight: "180px",
          //     input: {
          //       color: "black",
          //       fontSize: "20px",
          //       fontFamily: "Times",
          //       inputHeight: "32px",
          //       inputMargin: "-1px",
          //       borderColor: "black",
          //       //backgroundColor: "green",
          //       borderWidth: "1px",
          //       borderRadius: "30px",
          //       outerRadius: "10px",
          //       // boxShadow: "0 0 10px 5px purple, 0 0 15px 10px lightblue",
          //       placeHolder: {
          //         color: "red",
          //         holderName: "Name On Card",
          //         cardNumber: "Number",
          //         expiryDate: "MM/YY",
          //         securityCode: "CVV",
          //       },
          //     },
          //     text: {
          //       saveCard: "Save card info for future payments",
          //       addCard: "Use another Card!",
          //       deleteAlert: {
          //         title: "Delete",
          //         message: "Are you sure?",
          //         confirm: "YES",
          //         cancel: "NO",
          //       },
          //     },
          //     label: {
          //       display: false,
          //       color: "black",
          //       fontSize: "13px",
          //       fontWeight: "bold",
          //       fontFamily: "Times",
          //       text: {
          //         holderName: "Card Holder Name",
          //         cardNumber: "Card Number",
          //         expiryDate: "Expiry Date",
          //         securityCode: "Security Code",
          //       },
          //     },
          //     error: {
          //       borderColor: "red",
          //       //boxShadow: "0 0 10px 5px purple, 0 0 15px 10px lightblue",
          //       borderRadius: "8px",
          //     },
          //     button: {
          //       textContent: "Pay",
          //       fontSize: "16px",
          //       fontFamily: "Times",
          //       color: "white",
          //       backgroundColor: "#4daee0",
          //       height: "30px",
          //       borderRadius: "8px",
          //       width: "70%",
          //       margin: "0 auto",
          //       cursor: "pointer",
          //     },
          //     separator: {
          //       useCustomSeparator: false,
          //       textContent: "Enter your card",
          //       fontSize: "20px",
          //       color: "#4daee0",
          //       fontFamily: "sans-serif",
          //       textSpacing: "2px",
          //       lineStyle: "dashed",
          //       lineColor: "black",
          //       lineThickness: "3px",
          //     },
          //   },
          // },
          // stcPay: {
          //   mobileNumber: "0548220713",
          //   // language: "en",
          //   style: {
          //     frameHeight: "40px",
          //     frameWidth: "100%",
          //     input: {
          //       color: "#582490",
          //       fontSize: "14px",
          //       fontFamily: "'roboto', sans-serif",
          //       inputHeight: "40px",
          //       borderColor: "black",
          //       borderWidth: "2px",
          //       borderRadius: "9px",
          //       placeHolder: {
          //         mobileNumber: "05________",
          //         otpValue: "Enter OTP!",
          //       },
          //     },
          //     button: {
          //       borderRadius: "9px",
          //       height: "40px",
          //     },
          //   },
          // },
        },
      };

      myfatoorah.init(config);

      //Embedded Functions
      function payment(response) {
        console.log(JSON.stringify(response));
      }

      function eventHandler(event) {
        console.log("Event received:" + JSON.stringify(event));
      }

      //This function enables you to update the amount displayed on Apple Pay and Google Pay after the initiation of the config.
      function updateAmount(amount) {
        myfatoorah.updateAmount(amount);
      }
    </script>
  </body>
</html>
```

```html Tokenized Embedded Payment
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Embedded Payment</title>
    <script src="https://demo.myfatoorah.com/sessions/v1/session.js"></script>
  </head>

  <body style="background-color: white">
    <div style="width: 400px; margin: auto">
      <div id="unified-session"></div>
    </div>

    <!-- This is a div element for the CVV Component -->
    <div
      style="
        width: 400px;
        margin-top: 30px;
        margin-left: auto;
        margin-right: auto;
      "
      ;
      margin-bottom:
      5px;
    >
      <div id="cvv-component"></div>
    </div>

    <!-- This is a button for the submit CVV -->
    <button onclick="submitCvv()">Submit CVV</button>
    <script>
      var sessionId = "KWT-d2a00b6d-9e9b-4971-bc70-b10eade6a785"; //Add the "SessionId" you received from POST Session Endpoint.

      var configCvvView = {
        sessionId: sessionId,
        containerId: "cvv-component",
        callback: proceedCvv,
        shouldHandlePaymentUrl: true,
        // style: {
        //   frameHeight: "100px",
        //   error: {
        //     borderColor: "violet",
        //     borderRadius: "10px",
        //     //boxShadow: "10px 10px 5px #888888",
        //   },

        //   input: {
        //     color: "black",
        //     fontSize: "20px",
        //     fontFamily: "Sofia",
        //     inputHeight: "30px",
        //     inputMargin: "1px",
        //     borderColor: "blue",
        //     borderWidth: "3px",
        //     borderRadius: "25px",
        //     boxShadow: "",
        //     placeHolder: "security code(cvv)",
        //   },
        //   label: {
        //     display: true,
        //     color: "green",
        //     fontSize: "25px",
        //     fontWeight: "900",
        //     fontFamily: "Sofia",
        //     text: "cvv",
        //   },
        // },
      };

      myfatoorah.initCvv(configCvvView);

      //CVV Functions
      function proceedCvv(response) {
        if (response.isSuccess) {
          console.log("proceedCvv response >>\n" + JSON.stringify(response));
        } else {
          console.error("proceedCvv Error >> " + JSON.stringify(response));
        }
      }

      function submitCvv() {
        myfatoorah.submitCvv("TKN-0fb06aac-634d-418a-bf78-953202b67b53");
      }
    </script>
  </body>
</html>
```

<br />
