### 1
```ts
import { _decorator, Node } from "cc";
import { BaseComponent, BindUI } from "lsscript";
const { ccclass } = _decorator;

@ccclass("FileName")
class FileName extends BaseComponent {
    private _bindUI: BindUI;

    public setInit(args: {parent:Node}): void {
        this._setInit(args.parent);
        
    }

    protected _initView(): void {
        this._bindUI = this._getUI(this.node);
    }

    protected _initEvent(): void {
        if(this._bindUI.Btn("BtnClose")){
            this._addClick(this._bindUI.Btn("BtnClose"), this.NodeDestroy);
        }
    }

    protected _destroyBefore(): void {

    }
}

```

### pop1
```ts
import { _decorator, Node } from "cc";
import { BaseComponent, BindUI } from "lsscript";
const { ccclass } = _decorator;

@ccclass("FileName")
class FileName extends BaseComponent {
    private _bindUI: BindUI;
    private _sureCall:(comp:BaseComponent)=> boolean;

    public setInit(args: {parent:Node,sureCall?:(comp:BaseComponent)=> boolean}): void {
        this._sureCall = args.sureCall;
        this._setInit(args.parent);
    }

    protected _initView(): void {
        this._bindUI = this._getUI(this.node);
    }

    protected _initEvent(): void {
        this._addClick(this._bindUI.Btn("BtnSure"), this.NodeDestroy);
        this._addClick(this._bindUI.Btn("BtnClose"), this.NodeDestroy);
        this._addClick(this._bindUI.Btn("BtnSure"), ()=>{
            if(typeof this._sureCall === "function"){
                const res = this._sureCall(this);
                if(!res){
                    this.NodeDestroy();
                }
                return;
            }
            this.NodeDestroy();
        });
    }

    protected _destroyBefore(): void {

    }
}

```